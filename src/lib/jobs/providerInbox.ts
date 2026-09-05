// src/lib/jobs/providerInbox.ts
// Pure, UI-safe helpers for the provider-facing Direct Hire job inbox
// (the "Jobs for Me" section of src/app/jobs/page.tsx).
//
// Security note: these helpers are PRESENTATION ONLY. Authorization stays
// server-side in GET /api/jobs/mine (scoped by getCallerControlledAddresses)
// and in the lifecycle routes (verifyCallerControlsAddress). Hiding
// client-only controls here is UX correctness, not a security boundary.

export interface ProviderJob {
  id?: string;
  jobId: string | number;
  description?: string | null;
  clientSCA?: string | null;
  providerSCA?: string | null;
  budget?: string | number | bigint | null;
  status?: string | null;
  deliverableHash?: string | null;
  isProvider?: boolean;
  isClient?: boolean;
}

/** Privacy-safe address: `0x1234…abcd`. Never throws; never returns full address. */
export function truncateAddress(addr: unknown): string {
  if (typeof addr !== 'string' || addr.length < 10) return '—';
  const s = addr.trim();
  if (!/^0x[0-9a-fA-F]{10,}$/.test(s)) return '—';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

/** Format a micro-USDC budget (6 decimals, BigInt-as-string) as `X.XX USDC`. Never throws. */
export function formatBudgetUsdc(budget: unknown): string {
  try {
    if (budget === null || budget === undefined || budget === '') return '—';
    const n = Number(budget as any) / 1e6;
    if (!Number.isFinite(n) || n < 0) return '—';
    return `${n.toFixed(2)} USDC`;
  } catch {
    return '—';
  }
}

/** Raw micro-USDC budget as bigint-equivalent number; 0n-safe. Never throws. */
export function budgetIsZero(budget: unknown): boolean {
  try {
    if (budget === null || budget === undefined || budget === '') return true;
    return BigInt(String(budget).trim()) === 0n;
  } catch {
    // Non-integer strings (e.g. "1.5") fall back to numeric comparison.
    const n = Number(budget as any);
    return !Number.isFinite(n) || n === 0;
  }
}

export type ProviderNextActionKind =
  | 'accept' // OPEN + no budget: provider must set budget/accept first
  | 'wait-funding' // OPEN + budget set: waiting on client to fund
  | 'submit' // FUNDED: provider submits deliverable
  | 'wait-review' // SUBMITTED: waiting on client to complete/pay
  | 'done' // COMPLETED
  | 'terminal' // REJECTED / EXPIRED / other
  | 'unknown';

export interface ProviderNextAction {
  kind: ProviderNextActionKind;
  /** Short label rendered as the card's next-action headline. */
  title: string;
  /** One-two sentence explanation of the step + which existing route it uses. */
  detail: string;
  /**
   * The ONLY Manage-tab action a provider may take from here.
   * Deliberately never 'approve' | 'fund' | 'complete' — those are
   * client-signed and must not appear for the provider role.
   */
  manageAction: 'submit' | null;
}

/**
 * Derive the provider's next required action from canonical status + budget.
 * Pure + total: unknown statuses/budgets map to 'unknown', never throw.
 */
export function getProviderNextAction(job: Pick<ProviderJob, 'status' | 'budget'>): ProviderNextAction {
  const status = typeof job?.status === 'string' ? job.status : '';
  switch (status) {
    case 'Open':
      if (budgetIsZero(job?.budget)) {
        return {
          kind: 'accept',
          title: 'Action needed: set your budget to accept',
          detail:
            'This job is waiting on you. Set your price with the existing provider route ' +
            'POST /api/jobs/[jobId]/accept { budget } (or the Direct Hire “Set Budget” step) — ' +
            'signed by your provider wallet. After that the client funds escrow.',
          manageAction: null,
        };
      }
      return {
        kind: 'wait-funding',
        title: 'Budget set — waiting on client to fund',
        detail:
          'Your price is on-chain. No provider action needed right now — the client ' +
          'approves USDC and funds escrow next.',
        manageAction: null,
      };
    case 'Funded':
      return {
        kind: 'submit',
        title: 'Funded — submit your deliverable',
        detail:
          'Escrow is funded. Submit your work with the existing provider route ' +
          '(Manage → Submit Deliverable), signed by your provider wallet.',
        manageAction: 'submit',
      };
    case 'Submitted':
      return {
        kind: 'wait-review',
        title: 'Submitted — waiting on client review',
        detail:
          'Your deliverable is on-chain. No provider action needed — the client ' +
          'completes the job and releases payment.',
        manageAction: null,
      };
    case 'Completed':
      return {
        kind: 'done',
        title: 'Completed — payment released',
        detail: 'This job is done and escrow has been released to you.',
        manageAction: null,
      };
    case 'Rejected':
    case 'Expired':
      return {
        kind: 'terminal',
        title: status === 'Expired' ? 'Expired — no further actions' : 'Rejected — no further actions',
        detail: 'This job reached a terminal state. No provider action is possible.',
        manageAction: null,
      };
    default:
      return {
        kind: 'unknown',
        title: 'Status unknown — open in Manage to inspect',
        detail: 'Open this job in the Manage tab to see its current on-chain state.',
        manageAction: null,
      };
  }
}

/**
 * Normalize a GET /api/jobs/mine response body into a safe job array.
 * Total: malformed/empty/garbage input yields [] — never throws, never crashes UI.
 */
export function normalizeMineResponse(data: unknown): ProviderJob[] {
  try {
    if (!data || typeof data !== 'object') return [];
    const jobs = (data as any).jobs;
    if (!Array.isArray(jobs)) return [];
    return jobs.filter(
      (j): j is ProviderJob =>
        !!j && typeof j === 'object' && j.jobId !== undefined && j.jobId !== null
    );
  } catch {
    return [];
  }
}
