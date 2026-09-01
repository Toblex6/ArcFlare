// src/lib/payrollChatParser.ts

export type Frequency = "daily" | "weekly" | "monthly";

export type ParsedIntent =
  | { type: "add_contractor"; name: string; address: string; amount: number; frequency: Frequency; intervalDays: number }
  | { type: "remove_contractor"; name: string }
  | { type: "list_contractors" }
  | { type: "clear_contractors" }
  | { type: "check_balance" }
  | { type: "set_schedule"; frequency: Frequency; intervalDays: number }
  | { type: "run_payroll" }
  | { type: "show_receipts" }
  | { type: "unrecognized"; raw: string };

export const FREQUENCY_TO_DAYS: Record<Frequency, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

// ── Pattern 1: Add contractor ──────────────────────────────────────────────
// Loosened after real-world testing: any role word (contractor, employee,
// manager, designer, …) and both "monthly" AND "every N days/weeks/months"
// interval styles. The old pattern hard-required
// "as a contractor|employee at <amount> [usdc] <frequency>" and rejected
// natural phrasing like "… as a manager at 1 usdc every 4 weeks".
const ADD_PATTERN =
  /add\s+(\w+)\s+(0x[a-fA-F0-9]{40})\s+as\s+(?:a|an)\s+(\w+)\s+at\s+([\d.]+)\s*(?:usdc)?[\s,]*(?:(?:every|per)\s+(\d+)\s*(days?|weeks?|months?)|(daily)|(weekly)|(monthly))/i;

// ── Pattern 2: List contractors ────────────────────────────────────────────
const LIST_PATTERN = /(?:list|show)\s+(?:my\s+)?(?:contractors?|people|recipients|team)/i;

// ── Pattern 3: Clear contractors ───────────────────────────────────────────
const CLEAR_PATTERN = /(?:clear|remove|delete)\s+(?:all\s+)?(?:contractors?|people|recipients|team)/i;

// ── Pattern 4: Balance check ──────────────────────────────────────────────
const BALANCE_PATTERN = /(?:what'?s|check|show)\s+(?:my\s+)?(?:vault\s+)?balance/i;

// ── Pattern 5: Set schedule (also accepts "set payroll to run every N days/weeks/months")
const SCHEDULE_PATTERN = /set\s+payroll\s+(?:to\s+run\s+)?(?:(daily)|(weekly)|(monthly)|(?:every|per)\s+(\d+)\s*(days?|weeks?|months?))/i;

// ── Pattern 6: Run payroll ─────────────────────────────────────────────────
const RUN_PATTERN = /\b(?:run|execute)\s+payroll\b/i;

// ── Pattern 7: Show receipts ───────────────────────────────────────────────
const RECEIPTS_PATTERN = /(?:show|view)\s+(?:my\s+)?(?:payroll\s+)?receipts/i;

/**
 * Normalizes a parsed frequency to the closest Frequency bucket.
 * "every 4 weeks" → weekly-ish: stored as its own day count via
 * FREQUENCY_TO_DAYS at execution time — here we pick the smallest bucket
 * that is >= the interval so recurring runs never fire early, and carry
 * the exact interval days alongside.
 */
function normalizeFrequency(match: {
  everyN?: string | undefined;
  unit?: string | undefined;
  daily?: boolean;
  weekly?: boolean;
  monthly?: boolean;
}): { frequency: Frequency; intervalDays: number } {
  if (match.daily) return { frequency: "daily", intervalDays: 1 };
  if (match.weekly) return { frequency: "weekly", intervalDays: 7 };
  if (match.monthly) return { frequency: "monthly", intervalDays: 30 };
  const n = parseInt(match.everyN || "1", 10) || 1;
  const unit = (match.unit || "").toLowerCase();
  if (unit.startsWith("day")) return { frequency: "daily", intervalDays: n };
  if (unit.startsWith("week")) return { frequency: "weekly", intervalDays: n * 7 };
  return { frequency: "monthly", intervalDays: n * 30 };
}

/**
 * Parses a single chat message into a structured payroll intent.
 */
export function parsePayrollCommand(message: string): ParsedIntent {
  const trimmed = message.trim();

  const addMatch = trimmed.match(ADD_PATTERN);
  if (addMatch) {
    // Groups: 1 name · 2 address · 3 role (unused beyond matching) · 4 amount
    //         5 every-N · 6 unit | 7 daily | 8 weekly | 9 monthly
    const [, name, address, , amountStr, everyN, unit, daily, weekly, monthly] = addMatch;
    const { frequency, intervalDays } = normalizeFrequency({
      everyN,
      unit,
      daily: Boolean(daily),
      weekly: Boolean(weekly),
      monthly: Boolean(monthly),
    });
    return {
      type: "add_contractor",
      name,
      address,
      amount: parseFloat(amountStr),
      frequency,
      intervalDays,
    };
  }

  if (LIST_PATTERN.test(trimmed)) {
    return { type: "list_contractors" };
  }

  if (CLEAR_PATTERN.test(trimmed)) {
    return { type: "clear_contractors" };
  }

  if (BALANCE_PATTERN.test(trimmed)) {
    return { type: "check_balance" };
  }

  const scheduleMatch = trimmed.match(SCHEDULE_PATTERN);
  if (scheduleMatch) {
    // Groups: 1 daily · 2 weekly · 3 monthly · 4 every-N · 5 unit
    const { frequency, intervalDays } = normalizeFrequency({
      everyN: scheduleMatch[4],
      unit: scheduleMatch[5],
      daily: Boolean(scheduleMatch[1]),
      weekly: Boolean(scheduleMatch[2]),
      monthly: Boolean(scheduleMatch[3]),
    });
    return { type: "set_schedule", frequency, intervalDays };
  }

  if (RUN_PATTERN.test(trimmed)) {
    return { type: "run_payroll" };
  }

  if (RECEIPTS_PATTERN.test(trimmed)) {
    return { type: "show_receipts" };
  }

  return { type: "unrecognized", raw: trimmed };
}

/**
 * Loose partial extraction for multi-turn adds. Pulls whatever add-shaped
 * fields it can from a single free-text message so a pending add survives
 * greetings ("hi"/"hello") that would otherwise dilute the LLM's context
 * window. Never used as a source of truth — only a hint merged into the
 * context the LLM sees (sanitizeAddArgs stays authoritative).
 */
export function extractPartialAdd(text: string): {
  name?: string;
  address?: string;
  amount?: number;
  frequency?: Frequency;
  intervalDays?: number;
} {
  const out: { name?: string; address?: string; amount?: number; frequency?: Frequency; intervalDays?: number } = {};
  const trimmed = text.trim();

  const addr = trimmed.match(/0x[a-fA-F0-9]{40}/i);
  if (addr) out.address = addr[0];

  // amount — conservative: only explicit "N usdc", "at $N", "at N usdc",
  // or "pay/pay/send/sending $N" phrasings so dates/counts are never grabbed
  const amtMatch =
    trimmed.match(/(?:^|\s)(\d+(?:\.\d{1,6})?)\s*(?:usdc|u)\b/i) ||
    trimmed.match(/\bat\s+\$?(\d+(?:\.\d{1,6})?)\s*(?:usdc)?/i) ||
    trimmed.match(/(?:pay|paying|send|sending)\s+\$?(\d+(?:\.\d{1,6})?)/i);
  if (amtMatch) out.amount = parseFloat(amtMatch[1]);

  const cadMatch = trimmed.match(/(?:every|per)\s+(\d+)\s*(days?|weeks?|months?)/i);
  if (cadMatch) {
    const n = parseInt(cadMatch[1], 10) || 1;
    const unit = cadMatch[2].toLowerCase();
    if (unit.startsWith("day")) { out.frequency = "daily"; out.intervalDays = n; }
    else if (unit.startsWith("week")) { out.frequency = "weekly"; out.intervalDays = n * 7; }
    else { out.frequency = "monthly"; out.intervalDays = n * 30; }
  } else if (/\bdaily\b/i.test(trimmed)) { out.frequency = "daily"; out.intervalDays = 1; }
  else if (/\bweekly\b/i.test(trimmed)) { out.frequency = "weekly"; out.intervalDays = 7; }
  else if (/\bmonthly\b/i.test(trimmed)) { out.frequency = "monthly"; out.intervalDays = 30; }

  // name — only a bare single word (e.g. "deji") so full sentences aren't
  // mis-captured. "add them now" has multiple words and is skipped, and a
  // greeting ("hello", "hi") is never mistaken for a contractor name.
  if (!addr && trimmed.length <= 60) {
    const words = trimmed.split(/\s+/).filter((w) => !/^0x/i.test(w));
    if (words.length === 1 && !/^(hi|hii|hello|hey|heyy|yo|thanks|thank|ty|ok|okay|yes|no|yep|yeah|bye|good|fine|help|list|run|clear|show|add|remove)$/i.test(words[0])) {
      out.name = words[0].slice(0, 60);
    }
  }

  return out;
}

export const EXAMPLE_COMMANDS = [
  "Add Flare 0xAbC123... as a contractor at 2 USDC monthly",
  "Add Manny 0xAbC123... as a manager at 1 usdc every 4 weeks",
  "List my contractors",
  "Clear all contractors",
  "What's my vault balance?",
  "Set payroll to run weekly",
  "Run payroll",
  "Show my payroll receipts",
];