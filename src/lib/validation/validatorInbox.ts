// src/lib/validation/validatorInbox.ts
// Pure, UI-safe helpers for the validator inbox (the "Validator Inbox"
// sub-tab of the Validation tab in src/app/agents/page.tsx).
//
// Security note: these helpers are PRESENTATION ONLY. Authorization stays
// server-side in GET /api/agent/validation/inbox (scoped by
// getCallerControlledAddresses — the caller never supplies a validator
// address) and in the hardened responder (resolveResponseValidator +
// verifyCallerControlsAddress in POST /api/agent/validation). Hiding
// requester-only controls here is UX correctness, not a security boundary.
//
// Data note: the inbox is built from data that already exists —
// Erc8183JobValidation rows (job-linked validation requests, created at hire
// time and hash-stamped at request time) joined to their Erc8183Job, plus a
// best-effort on-chain mirror (getValidationStatus, authoritative). Plain
// non-job ERC-8004 agent validations have no persisted record (see
// src/lib/notifyValidator.ts receiver-gap note) and are therefore NOT
// discoverable here — only via the request notification / manual hash entry.

export interface InboxJobContext {
  jobId?: string | number | bigint | null;
  description?: string | null;
  clientSCA?: string | null;
  providerSCA?: string | null;
  status?: string | null;
  agentTokenId?: string | null;
  agentName?: string | null;
}

export interface InboxItem {
  requestHash?: string | null;
  validatorSCA?: string | null;
  status?: string | null;
  tag?: string | null;
  required?: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  requestTxHash?: string | null;
  responseTxHash?: string | null;
  job?: InboxJobContext | null;
  onChain?: {
    pending?: boolean | null;
    passed?: boolean | null;
    response?: number | null;
    tag?: string | null;
  } | null;
  onChainUnavailable?: boolean;
}

export type InboxClassification =
  | 'pending' // still respondable → show Review → Respond
  | 'responded' // already resolved on-chain or in DB → status only, never actionable
  | 'unavailable'; // not yet requested / expired / on-chain unreadable → status only

export interface ClassifiedInboxItem {
  item: InboxItem;
  classification: InboxClassification;
  /** Short human reason for the classification (rendered as status copy). */
  reason: string;
  /** True only for pending items — the single actionable state. */
  actionable: boolean;
}

/** Privacy-safe address: `0x1234…abcd`. Never throws; never returns full address. */
export function truncateAddress(addr: unknown): string {
  if (typeof addr !== 'string' || addr.length < 10) return '—';
  const s = addr.trim();
  if (!/^0x[0-9a-fA-F]{10,}$/.test(s)) return '—';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/**
 * Classify one inbox row as pending / responded / unavailable.
 * Pure + total: malformed/empty/garbage input yields 'unavailable', never throws.
 *
 * Precedence (on-chain is authoritative, DB is the mirror):
 *  1. No usable requestHash → 'unavailable' (policy created but never requested,
 *     or malformed record — nothing to respond to).
 *  2. On-chain readable and NOT pending → 'responded' (response already landed).
 *  3. DB status PASSED/FAILED → 'responded' (mirror agrees it is resolved;
 *     shown as resolved even if the on-chain read failed).
 *  4. On-chain readable and pending → 'pending' (respondable).
 *  5. On-chain unreadable + DB not terminal → 'unavailable' (fail-closed
 *     display: never present an unreadable row as actionable).
 */
export function classifyInboxItem(raw: unknown): ClassifiedInboxItem {
  const fallback: ClassifiedInboxItem = {
    item: {},
    classification: 'unavailable',
    reason: 'Malformed record — unavailable.',
    actionable: false,
  };
  try {
    if (!raw || typeof raw !== 'object') return fallback;
    const item = raw as InboxItem;
    const hash = typeof item.requestHash === 'string' ? item.requestHash.trim() : '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      return {
        item,
        classification: 'unavailable',
        reason: item.requestHash == null
          ? 'Validation requested — waiting for the on-chain request.'
          : 'Malformed record — unavailable.',
        actionable: false,
      };
    }
    const dbStatus = typeof item.status === 'string' ? item.status.toUpperCase() : '';
    if (dbStatus === 'PASSED' || dbStatus === 'FAILED') {
      return {
        item,
        classification: 'responded',
        reason: dbStatus === 'PASSED' ? 'Validation PASSED — already resolved.' : 'Validation FAILED — already resolved.',
        actionable: false,
      };
    }
    const onChain = item.onChain;
    if (onChain && typeof onChain === 'object') {
      if (onChain.pending === false) {
        const passed = onChain.passed === true;
        return {
          item,
          classification: 'responded',
          reason: passed ? 'Validation PASSED — already resolved.' : 'Validation responded — already resolved.',
          actionable: false,
        };
      }
      if (onChain.pending === true) {
        return {
          item,
          classification: 'pending',
          reason: 'Awaiting your response.',
          actionable: true,
        };
      }
    }
    if (item.onChainUnavailable) {
      return { item, classification: 'unavailable', reason: 'On-chain status unavailable — try again.', actionable: false };
    }
    // Hash exists but no on-chain signal yet (e.g. still indexing): show as
    // pending only when the DB explicitly says REQUESTED; otherwise display
    // fail-closed so an unproven row is never actionable.
    if (dbStatus === 'REQUESTED') {
      return { item, classification: 'pending', reason: 'Awaiting your response.', actionable: true };
    }
    return { item, classification: 'unavailable', reason: 'Status unknown — inspect before responding.', actionable: false };
  } catch {
    return fallback;
  }
}

/**
 * Validator-side scoping filter (defense-in-depth mirror of the server
 * WHERE clause). Keeps only rows whose validatorSCA is in `controlled`
 * (case-insensitive). Pure + total: garbage rows are dropped, never throw.
 */
export function filterInboxForValidator(rows: unknown, controlled: Set<string> | string[]): InboxItem[] {
  try {
    if (!Array.isArray(rows)) return [];
    const allowed = new Set<string>();
    if (controlled instanceof Set) {
      for (const a of controlled) {
        if (typeof a === 'string' && a) allowed.add(a.toLowerCase());
      }
    } else if (Array.isArray(controlled)) {
      for (const a of controlled) {
        if (typeof a === 'string' && a) allowed.add(a.toLowerCase());
      }
    }
    if (allowed.size === 0) return [];
    return rows.filter((r): r is InboxItem => {
      if (!r || typeof r !== 'object') return false;
      const v = (r as InboxItem).validatorSCA;
      return typeof v === 'string' && allowed.has(v.toLowerCase());
    });
  } catch {
    return [];
  }
}

/**
 * Normalize a GET /api/agent/validation/inbox response body into safe
 * classified rows. Total: malformed/empty/garbage input yields [] — never
 * throws, never crashes the UI. One malformed record never hides the rest:
 * each row is classified independently inside its own try/catch.
 */
export function normalizeInboxResponse(data: unknown): ClassifiedInboxItem[] {
  try {
    if (!data || typeof data !== 'object') return [];
    const items = (data as any).items;
    if (!Array.isArray(items)) return [];
    const out: ClassifiedInboxItem[] = [];
    for (const raw of items) {
      try {
        if (!raw || typeof raw !== 'object') continue;
        out.push(classifyInboxItem(raw));
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}
