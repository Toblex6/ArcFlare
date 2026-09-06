// src/lib/nanopayment.ts
// Nanopayment batching logic.
// Records micro-charges in Postgres without settling immediately.
// When threshold or time interval is reached, batches and settles.
//
// PHASE 2C MULTICURRENCY: batching groups by agent + merchant + TOKEN, never
// by payer/merchant alone. Each NanoPayment row carries a canonical
// currency/tokenAddress (resolved through resolveCurrency at record time;
// historical NULL tokenAddress rows resolve to USDC via resolveRowCurrency),
// and every helper below scopes to a single token so USDC rows can never be
// combined into an EURC transfer. No SwapPool is involved — the row's token
// is the transfer's token.

import { prisma } from '@/lib/prisma';
import { resolveCurrency, resolveRowCurrency } from '@/lib/tokens/resolveCurrency';
import type { CurrencyRef } from '@/lib/tokens/resolveCurrency';

// ─── Config ───────────────────────────────────────────────────────────────────
export const NANO_BATCH_THRESHOLD_USDC = 1.0; // Settle when batch reaches 1 USDC
export const NANO_BATCH_INTERVAL_MS = 60000; // Or every 60 seconds

export type { CurrencyRef };

// A token batch key: agent (payer) + merchant (provider) + canonical token.
// This is the ONLY grouping settle paths may use.
export interface NanoBatchKey {
  agentSCA: string;
  merchantSCA: string;
  currency: 'USDC' | 'EURC';
  tokenAddress: string;
  decimals: number;
}

interface NanoRowLike {
  agentSCA: string;
  merchantSCA: string;
  amount: number;
  currency?: string | null;
  tokenAddress?: string | null;
}

/** Resolve a nano row's canonical token. Historical NULL → USDC. */
export function resolveNanoToken(row: { currency?: string | null; tokenAddress?: string | null }): CurrencyRef {
  return resolveRowCurrency(row);
}

/**
 * Pure grouping helper: split rows into single-token batches keyed by
 * agent + merchant + canonical token address. Mixed-token input yields one
 * group per token — never a combined group. Used by the settle path and
 * directly asserted by the Phase 2C isolation tests.
 */
export function groupNanoRowsByToken<T extends NanoRowLike>(rows: T[]): Array<NanoBatchKey & { rows: T[]; total: number }> {
  const groups = new Map<string, NanoBatchKey & { rows: T[]; total: number }>();
  for (const row of rows) {
    const token = resolveNanoToken(row);
    const key = `${row.agentSCA.toLowerCase()}|${row.merchantSCA.toLowerCase()}|${token.address.toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        agentSCA: row.agentSCA,
        merchantSCA: row.merchantSCA,
        currency: token.symbol,
        tokenAddress: token.address,
        decimals: token.decimals,
        rows: [],
        total: 0,
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.total = parseFloat((group.total + row.amount).toFixed(6));
  }
  return [...groups.values()];
}

/** True when a row belongs to the given canonical token (NULL → USDC). */
function rowMatchesToken(row: { currency?: string | null; tokenAddress?: string | null }, token: CurrencyRef): boolean {
  try {
    return resolveNanoToken(row).address.toLowerCase() === token.address.toLowerCase();
  } catch {
    return false;
  }
}

/** Resolve an optional caller-supplied token filter; null = no filter. */
function resolveTokenFilter(ref?: { currency?: string | null; tokenAddress?: string | null } | null): CurrencyRef | null {
  if (!ref) return null;
  if (ref.currency == null && ref.tokenAddress == null) return null;
  return resolveCurrency({ currency: ref.currency, tokenAddress: ref.tokenAddress });
}

// ─── Record a single nanopayment ─────────────────────────────────────────────
export async function recordNanoPayment({
  agentSCA,
  merchantSCA,
  amount,
  description,
  currency,
  tokenAddress,
}: {
  agentSCA: string;
  merchantSCA: string;
  amount: number;
  description?: string;
  // Phase 2C: the charge's denomination. Resolved through the canonical
  // resolver (rejects unsupported symbols/addresses and mismatches); legacy
  // callers omit both and record USDC exactly as before.
  currency?: string | null;
  tokenAddress?: string | null;
}) {
  const token = resolveCurrency({ currency, tokenAddress });
  const nano = await prisma.nanoPayment.create({
    data: {
      agentSCA,
      merchantSCA,
      amount,
      currency: token.symbol,
      tokenAddress: token.address,
      description,
      settled: false,
    },
  });
  return nano;
}

// ─── Get total unsettled balance for an agent-merchant pair ──────────────────
// token-aware: pass { currency, tokenAddress } to scope to one token; omit
// to sum the whole pair (legacy behavior, used only for display/threshold
// hints — settlement always scopes per token).
export async function getUnsettledBalance(
  agentSCA: string,
  merchantSCA: string,
  tokenRef?: { currency?: string | null; tokenAddress?: string | null } | null
) {
  const token = resolveTokenFilter(tokenRef);
  const unsettled = await prisma.nanoPayment.findMany({
    where: { agentSCA, merchantSCA, settled: false },
  });
  const scoped = token ? unsettled.filter((n) => rowMatchesToken(n as any, token)) : unsettled;

  const total = scoped.reduce((sum, n) => sum + n.amount, 0);
  return {
    total: parseFloat(total.toFixed(6)),
    count: scoped.length,
    payments: scoped,
    ...(token ? { currency: token.symbol, tokenAddress: token.address } : {}),
  };
}

// ─── Check if batch threshold is reached ─────────────────────────────────────
export async function shouldBatchSettle(
  agentSCA: string,
  merchantSCA: string,
  tokenRef?: { currency?: string | null; tokenAddress?: string | null } | null
) {
  const { total } = await getUnsettledBalance(agentSCA, merchantSCA, tokenRef);
  return total >= NANO_BATCH_THRESHOLD_USDC;
}

// ─── Mark a batch as settled ──────────────────────────────────────────────────
export async function markBatchSettled(
  agentSCA: string,
  merchantSCA: string,
  tokenRef?: { currency?: string | null; tokenAddress?: string | null } | null
) {
  const token = resolveTokenFilter(tokenRef);
  if (!token) {
    // Removed batchRef update since it doesn't exist in the current schema
    await prisma.nanoPayment.updateMany({
      where: { agentSCA, merchantSCA, settled: false },
      data: { settled: true },
    });
    return;
  }
  // Token-scoped: only rows resolving to this token are marked, so a USDC
  // settlement can never mark EURC rows settled (or vice versa).
  const unsettled = await prisma.nanoPayment.findMany({
    where: { agentSCA, merchantSCA, settled: false },
    select: { id: true, currency: true, tokenAddress: true },
  });
  const ids = unsettled.filter((n) => rowMatchesToken(n as any, token)).map((n) => n.id);
  if (ids.length > 0) {
    await prisma.nanoPayment.updateMany({
      where: { id: { in: ids } },
      data: { settled: true },
    });
  }
}

// ─── Get all unsettled pairs that need batching ───────────────────────────────
// Phase 2C: returns one entry per agent + merchant + TOKEN triple, so the
// auto-settler transfers each token separately and never merges them.
export async function getUnsettledPairs(): Promise<NanoBatchKey[]> {
  const unsettled = await prisma.nanoPayment.findMany({
    where: { settled: false },
    select: { agentSCA: true, merchantSCA: true, currency: true, tokenAddress: true },
  });
  const seen = new Map<string, NanoBatchKey>();
  for (const row of unsettled) {
    let token: CurrencyRef;
    try {
      token = resolveNanoToken(row as any);
    } catch {
      continue; // unresolvable row — never batch what we cannot identify
    }
    const key = `${row.agentSCA.toLowerCase()}|${row.merchantSCA.toLowerCase()}|${token.address.toLowerCase()}`;
    if (!seen.has(key)) {
      seen.set(key, {
        agentSCA: row.agentSCA,
        merchantSCA: row.merchantSCA,
        currency: token.symbol,
        tokenAddress: token.address,
        decimals: token.decimals,
      });
    }
  }
  return [...seen.values()];
}

// ─── Get batch summary for a pair ─────────────────────────────────────────────
// token-aware: pass { currency, tokenAddress } to summarize one token batch.
export async function getBatchSummary(
  agentSCA: string,
  merchantSCA: string,
  tokenRef?: { currency?: string | null; tokenAddress?: string | null } | null
) {
  const token = resolveTokenFilter(tokenRef);
  const payments = (await prisma.nanoPayment.findMany({
    where: { agentSCA, merchantSCA, settled: false },
    orderBy: { createdAt: 'asc' },
  })).filter((n) => (!token ? true : rowMatchesToken(n as any, token)));

  const total = payments.reduce((sum, n) => sum + n.amount, 0);
  const oldest = payments[0]?.createdAt;
  const ageMs = oldest ? Date.now() - new Date(oldest).getTime() : 0;

  // The summary's token identity: the requested token, or — for legacy
  // unfiltered callers — the single token present (plus a mixed flag so
  // callers can see that one transfer cannot cover this pair).
  const groups = groupNanoRowsByToken(payments as any);
  const summaryToken = token ?? (groups.length === 1
    ? { symbol: groups[0].currency, address: groups[0].tokenAddress, decimals: groups[0].decimals }
    : { symbol: 'USDC' as const, address: resolveCurrency({ currency: 'USDC' }).address, decimals: 6 });

  return {
    agentSCA,
    merchantSCA,
    currency: summaryToken.symbol,
    tokenAddress: summaryToken.address,
    decimals: summaryToken.decimals,
    mixedTokens: groups.length > 1,
    tokenGroups: groups.map((g) => ({
      currency: g.currency,
      tokenAddress: g.tokenAddress,
      total: g.total,
      count: g.rows.length,
    })),
    total: parseFloat(total.toFixed(6)),
    count: payments.length,
    ageMs,
    shouldSettle: total >= NANO_BATCH_THRESHOLD_USDC || ageMs >= NANO_BATCH_INTERVAL_MS,
    payments,
  };
}
