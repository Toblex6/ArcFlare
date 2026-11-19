// src/lib/bridge/resumeStore.ts
//
// Persistent EXTERNAL Bridge resume state — the fix for the "in-memory only
// resumeRef" reliability gap.
//
// Background: ExternalBridge.tsx kept the soft/partial BridgeKit result in a
// useRef, so a browser close / reload during the attestation wait (minutes)
// made the intent unresumable from the UI even though funds may already have
// left the wallet and the server-side FlowBridgeIntent row still exists.
//
// This module persists the MINIMAL resume facts — intent reference (the
// FlowBridgeIntent id), source chain (BridgeKit id), and the burn tx hash
// when known — to localStorage, keyed per source wallet. After a reload the
// UI rehydrates from here and resumes server-side (status → verify →
// complete) instead of requiring the in-memory BridgeKit result object.
//
// Client-safe + SSR-safe (no-ops when window/localStorage is unavailable).
// Pure local persistence: the server remains authoritative (status/verify/
// complete prove everything on-chain); this store only remembers WHERE to
// resume, never WHETHER the bridge succeeded.

export interface BridgeResumeEntry {
  /** FlowBridgeIntent id (the `reference` the intent route returned). */
  intentReference: string;
  /** BridgeKit source-chain id, e.g. 'Arbitrum_Sepolia'. */
  sourceChainId: string;
  /** Lowercased source (session) wallet that owns the intent. */
  sourceWallet: string;
  /** Source-chain burn tx hash when one has been observed (else null). */
  burnTxHash: string | null;
  /** Destination hash observed from the SDK; server completion re-proves it. */
  mintTxHash?: string | null;
  /** Human amount string as typed (display only, never authoritative). */
  amount?: string;
  /** Server-resolved destination (display only, never authoritative). */
  destination?: string | null;
  /** True before invoking Bridge Kit. Missing on legacy entries = unknown. */
  signingStarted?: boolean;
  /** Epoch ms of the last write (used for TTL expiry). */
  updatedAt: number;
}

/**
 * Submission TTL only. It expires solely a saved attempt that is proven not
 * to have entered signing. A known or possible burn remains recoverable later.
 */
export const BRIDGE_RESUME_TTL_MS = 2 * 60 * 60 * 1000;

const KEY_PREFIX = 'flarehq:external-bridge:resume:';

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    const s = window.localStorage;
    if (!s) return null;
    return s;
  } catch {
    return null;
  }
}

export function resumeKeyForWallet(sourceWallet: string): string {
  return `${KEY_PREFIX}${sourceWallet.trim().toLowerCase()}`;
}

function isValidEntry(v: unknown): v is BridgeResumeEntry {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.intentReference === 'string' &&
    e.intentReference.length > 0 &&
    typeof e.sourceChainId === 'string' &&
    e.sourceChainId.length > 0 &&
    typeof e.sourceWallet === 'string' &&
    e.sourceWallet.length > 0 &&
    (e.burnTxHash === null ||
      e.burnTxHash === undefined ||
      (typeof e.burnTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(e.burnTxHash))) &&
    (e.mintTxHash == null || (typeof e.mintTxHash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(e.mintTxHash))) &&
    (e.signingStarted === undefined || typeof e.signingStarted === 'boolean') &&
    typeof e.updatedAt === 'number' &&
    Number.isFinite(e.updatedAt)
  );
}

/** Persist (overwrite) the resume entry for its sourceWallet. Never throws. */
export function saveBridgeResume(entry: Omit<BridgeResumeEntry, 'updatedAt'> & { updatedAt?: number }): void {
  try {
    const s = storage();
    if (!s) return;
    const full: BridgeResumeEntry = {
      ...entry,
      sourceWallet: entry.sourceWallet.trim().toLowerCase(),
      burnTxHash: entry.burnTxHash ?? null,
      updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
    };
    if (!isValidEntry(full)) return;
    s.setItem(resumeKeyForWallet(full.sourceWallet), JSON.stringify(full));
  } catch {
    // persistence must never break the bridge flow
  }
}

/**
 * Load the resume entry for a wallet. Returns null when absent, corrupt,
 * safely expired before signing, or owned by a different wallet. A missing
 * signingStarted flag is ambiguous (legacy/current crash), so it never expires.
 * Never throws.
 */
export function loadBridgeResume(sourceWallet: string): BridgeResumeEntry | null {
  try {
    const s = storage();
    if (!s) return null;
    const raw = s.getItem(resumeKeyForWallet(sourceWallet));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isValidEntry(parsed)) return null;
    if (parsed.sourceWallet.toLowerCase() !== sourceWallet.trim().toLowerCase()) return null;
    if (Date.now() - parsed.updatedAt > BRIDGE_RESUME_TTL_MS && !parsed.burnTxHash && !parsed.mintTxHash && parsed.signingStarted === false) {
      try {
        s.removeItem(resumeKeyForWallet(sourceWallet));
      } catch {}
      return null;
    }
    return { ...parsed, burnTxHash: parsed.burnTxHash ?? null };
  } catch {
    return null;
  }
}

/** Drop the resume entry for a wallet (receipt / start-over). Never throws. */
export function clearBridgeResume(sourceWallet: string): void {
  try {
    const s = storage();
    if (!s) return;
    s.removeItem(resumeKeyForWallet(sourceWallet));
  } catch {
    // ignore
  }
}

const BURN_STEP_ALIASES = new Set(['burn', 'depositforburn', 'deposit_for_burn']);

/**
 * Extract the source-chain burn tx hash from a BridgeKit result object.
 * Accepts the runtime 'burn' name plus the documented 'depositForBurn'
 * alias (same alias set as the UI's stepOf helper). Returns null when no
 * burn step with a txHash is present. Never throws.
 */
export function extractBurnTxHash(result: unknown): string | null {
  try {
    const steps: unknown = (result as { steps?: unknown })?.steps;
    if (!Array.isArray(steps)) return null;
    for (const step of [...steps].reverse()) {
      const s = step as { name?: unknown; txHash?: unknown };
      const n = String(s?.name ?? '').toLowerCase();
      if (n !== 'burn' && !BURN_STEP_ALIASES.has(n)) continue;
      if (typeof s?.txHash === 'string' && /^0x[0-9a-f]{64}$/i.test(s.txHash)) return s.txHash;
    }
    return null;
  } catch {
    return null;
  }
}
