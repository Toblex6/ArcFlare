// src/lib/payrollChatParser.ts

export type Frequency = "daily" | "weekly" | "monthly";

export type ParsedIntent =
  | { type: "add_contractor"; name: string; address: string; amount: number; frequency: Frequency }
  | { type: "list_contractors" }
  | { type: "clear_contractors" }
  | { type: "check_balance" }
  | { type: "set_schedule"; frequency: Frequency }
  | { type: "run_payroll" }
  | { type: "show_receipts" }
  | { type: "unrecognized"; raw: string };

export const FREQUENCY_TO_DAYS: Record<Frequency, number> = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

// ── Pattern 1: Add contractor ──────────────────────────────────────────────
const ADD_PATTERN =
  /add\s+(\w+)\s+(0x[a-fA-F0-9]{40})\s+as\s+a\s+(?:contractor|employee)\s+at\s+([\d.]+)\s*(?:usdc)?\s*(daily|weekly|monthly)/i;

// ── Pattern 2: List contractors ────────────────────────────────────────────
const LIST_PATTERN = /(?:list|show)\s+(?:my\s+)?(?:contractors?|people|recipients)/i;

// ── Pattern 3: Clear contractors ───────────────────────────────────────────
const CLEAR_PATTERN = /(?:clear|remove|delete)\s+(?:all\s+)?(?:contractors?|people|recipients)/i;

// ── Pattern 4: Balance check ──────────────────────────────────────────────
const BALANCE_PATTERN = /(?:what'?s|check|show)\s+(?:my\s+)?(?:vault\s+)?balance/i;

// ── Pattern 5: Set schedule ────────────────────────────────────────────────
const SCHEDULE_PATTERN = /set\s+payroll\s+to\s+run\s+(daily|weekly|monthly)/i;

// ── Pattern 6: Run payroll ─────────────────────────────────────────────────
const RUN_PATTERN = /\b(?:run|execute)\s+payroll\b/i;

// ── Pattern 7: Show receipts ───────────────────────────────────────────────
const RECEIPTS_PATTERN = /(?:show|view)\s+(?:my\s+)?(?:payroll\s+)?receipts/i;

/**
 * Parses a single chat message into a structured payroll intent.
 */
export function parsePayrollCommand(message: string): ParsedIntent {
  const trimmed = message.trim();

  const addMatch = trimmed.match(ADD_PATTERN);
  if (addMatch) {
    const [, name, address, amountStr, frequency] = addMatch;
    return {
      type: "add_contractor",
      name,
      address,
      amount: parseFloat(amountStr),
      frequency: frequency.toLowerCase() as Frequency,
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
    return { type: "set_schedule", frequency: scheduleMatch[1].toLowerCase() as Frequency };
  }

  if (RUN_PATTERN.test(trimmed)) {
    return { type: "run_payroll" };
  }

  if (RECEIPTS_PATTERN.test(trimmed)) {
    return { type: "show_receipts" };
  }

  return { type: "unrecognized", raw: trimmed };
}

export const EXAMPLE_COMMANDS = [
  "Add Flare 0xAbC123... as a contractor at 2 USDC monthly",
  "List my contractors",
  "Clear all contractors",
  "What's my vault balance?",
  "Set payroll to run weekly",
  "Run payroll",
  "Show my payroll receipts",
];