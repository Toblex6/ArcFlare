// src/lib/ledger/ledgerService.ts
// Append-only economic ledger (Build 3). PaymentLog remains authoritative for
// whether money moved; this is the derived accounting index per agent.
//
// Idempotency: txHash-first (txHash + agentId + type) when on-chain; else
// deterministic source composite. Duplicate retries hit dedupeKey unique.

import { prisma } from "@/lib/prisma";
import { resolveCurrency, resolveRowCurrency, tokenAddressFor } from "@/lib/tokens/resolveCurrency";

export const LEDGER_TYPES = {
  REVENUE: "REVENUE",
  AGENT_PAYMENT: "AGENT_PAYMENT",
  SUBCONTRACTOR_SPEND: "SUBCONTRACTOR_SPEND",
  JOB_ESCROW_LOCK: "JOB_ESCROW_LOCK",
  JOB_ESCROW_RELEASE: "JOB_ESCROW_RELEASE",
  PAYROLL_SPEND: "PAYROLL_SPEND",
  STREAM_REVENUE: "STREAM_REVENUE",
  STREAM_SPEND: "STREAM_SPEND",
  GAS: "GAS",
  REFUND: "REFUND",
  ADJUSTMENT: "ADJUSTMENT",
} as const;

export type LedgerType = (typeof LEDGER_TYPES)[keyof typeof LEDGER_TYPES];

export interface RecordLedgerParams {
  agentRegistryId: number;
  type: string;
  amount: bigint; // base units at the entry's token decimals (6 for USDC/EURC)
  token?: string;
  // Canonical ERC-20 address of the accounted token (Phase 2C multicurrency).
  // Persisted to AgentLedgerEntry.tokenAddress; omit only for legacy USDC
  // callers (NULL reads back as USDC). Never mix tokens in one entry.
  tokenAddress?: string | null;
  direction: "CREDIT" | "DEBIT";
  counterpartyAgentId?: number | null;
  paymentLogId?: string | null;
  jobId?: bigint | null;
  jobValidationId?: string | null;
  streamId?: string | null;
  txHash?: string | null;
  description?: string | null;
  metadata?: any;
  // for off-chain dedupe fallback
  sourceType?: string | null;
  sourceId?: string | null;
}

// Phase 2D dedupe note: the key stays txHash:agentId:type (or
// sourceType:sourceId:agentId:type off-chain). One on-chain transfer carries
// exactly one token, so one tx can never legitimately produce two entries
// with the same agent+type in different tokens — no token qualifier needed.
// Proven by the phase-2d suite (same-tx USDC+EURC entries with different
// types coexist; same-tx same-agent same-type is one economic event).
//
// Reader helper: resolve a ledger row's canonical token identity.
// Legacy NULL tokenAddress resolves from `token`, defaulting to USDC.
export function resolveLedgerToken(row: {
  token?: string | null;
  tokenAddress?: string | null;
}): { symbol: "USDC" | "EURC"; address: string; decimals: number; legacy: boolean } {
  const resolved = resolveRowCurrency({ currency: (row?.token as string | null) ?? null, tokenAddress: row?.tokenAddress ?? null });
  return { ...resolved, legacy: !row?.tokenAddress };
}

// Explicit USDC-only identity for writers whose underlying event is
// genuinely single-token (agent payments, jobs escrow, escrow, payroll,
// scheduled, nano, streams, treasury top-ups). Spread into recordLedgerEntry
// params so the row carries the canonical symbol + address. Never use for a
// multi-token event — pass that event's own resolved token instead.
export function usdcLedgerIdentity(): { token: string; tokenAddress: string } {
  return { token: "USDC", tokenAddress: tokenAddressFor("USDC") };
}

export function buildDedupeKey(p: RecordLedgerParams): string {
  const safeType = String(p.type).toUpperCase();
  if (p.txHash) {
    return `${p.txHash.toLowerCase()}:${p.agentRegistryId}:${safeType}`;
  }
  if (p.sourceType && p.sourceId) {
    return `${p.sourceType}:${p.sourceId}:${p.agentRegistryId}:${safeType}`;
  }
  throw new Error("recordLedgerEntry requires txHash or (sourceType+sourceId) for dedupe");
}

// Phase 2D: token identity is canonical, never inferred from amount.
// The originating event supplies the symbol/address; the resolver validates
// the pair (mismatch/unsupported throws — never silently accounted) and
// legacy callers with neither field default to USDC. New writes always
// persist the canonical address so readers never see a NULL for fresh rows.
export async function recordLedgerEntry(params: RecordLedgerParams): Promise<{ id: string; replayed: boolean }> {
  const dedupeKey = buildDedupeKey(params);
  const existing = await (prisma as any).agentLedgerEntry.findUnique({ where: { dedupeKey } }).catch(() => null);
  if (existing) return { id: existing.id, replayed: true };

  // Canonical token resolution — throws on unsupported/mismatched identity.
  // Never infer from amount; never assume 1 EURC = 1 USDC.
  const token = resolveCurrency({ currency: params.token ?? null, tokenAddress: params.tokenAddress ?? null });

  try {
    const row = await (prisma as any).agentLedgerEntry.create({
      data: {
        agentRegistryId: params.agentRegistryId,
        type: params.type,
        amount: params.amount.toString(),
        token: token.symbol,
        tokenAddress: token.address,
        direction: params.direction,
        counterpartyAgentId: params.counterpartyAgentId ?? null,
        paymentLogId: params.paymentLogId ?? null,
        jobId: params.jobId ?? null,
        jobValidationId: params.jobValidationId ?? null,
        streamId: params.streamId ?? null,
        txHash: params.txHash ? params.txHash.toLowerCase() : null,
        dedupeKey,
        description: params.description ?? null,
        metadata: params.metadata ?? null,
      },
    });
    return { id: row.id, replayed: false };
  } catch (e: any) {
    if (e?.code === "P2002") {
      const winner = await (prisma as any).agentLedgerEntry.findUnique({ where: { dedupeKey } }).catch(() => null);
      if (winner) return { id: winner.id, replayed: true };
    }
    throw e;
  }
}

/**
 * Resolve agentRegistryId by SCA address (case-insensitive). Returns null if
 * no agent owns that SCA (e.g. external EOA or merchant wallet).
 */
export async function resolveAgentIdBySca(sca: string): Promise<number | null> {
  if (!sca || !/^0x[a-fA-F0-9]{40}$/.test(sca)) return null;
  const agent = await (prisma as any).agentRegistry.findFirst({
    where: { scaAddress: { equals: sca, mode: "insensitive" } },
    select: { id: true },
  });
  return agent?.id ?? null;
}

/**
 * Resolve agent by X402 EOA address (payment EOA). Checks X402EoaWallet -> agentRegistryId.
 */
export async function resolveAgentIdByEoa(eoa: string): Promise<number | null> {
  if (!eoa || !/^0x[a-fA-F0-9]{40}$/.test(eoa)) return null;
  const row = await (prisma as any).x402EoaWallet.findUnique({
    where: { address: eoa },
    select: { agentRegistryId: true },
  }).catch(() => null);
  if (row?.agentRegistryId) return row.agentRegistryId;
  // fallback: try case-insensitive scan via agentRegistry sca? The EOA is not an SCA, so only X402 wallet maps.
  const all = await (prisma as any).x402EoaWallet.findMany({ select: { address: true, agentRegistryId: true } }).catch(() => []);
  const hit = all.find((r: any) => r.address?.toLowerCase() === eoa.toLowerCase());
  return hit?.agentRegistryId ?? null;
}
