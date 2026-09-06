// src/lib/ledger/treasuryService.ts
// Economic views derived from AgentLedgerEntry + live job escrow state.
// All totals are bigint (6-dec) internally, formatted as decimal strings in API.

import { prisma } from "@/lib/prisma";
import { resolveRowCurrency, tokenAddressFor } from "@/lib/tokens/resolveCurrency";

function b(s: string | bigint): bigint {
  try { return BigInt(s as string); } catch { return 0n; }
}

// Phase 2D: resolve one ledger row to its canonical token symbol.
// Legacy NULL tokenAddress resolves from `token`, defaulting to USDC;
// an unresolvable row degrades to USDC (same read-model rule as payments)
// so a corrupt row degrades instead of failing the whole view.
function rowSymbol(e: any): string {
  try {
    return resolveRowCurrency({ currency: e?.token ?? null, tokenAddress: e?.tokenAddress ?? null }).symbol;
  } catch {
    return "USDC";
  }
}

function rowIsLegacy(e: any): boolean {
  return !e?.tokenAddress;
}

export interface TokenSlice {
  symbol: string;
  tokenAddress: string;
  decimals: number;
  revenue: string;
  costs: string;
  escrowLocked: string;
  treasuryBalance: string;
  entryCount: number;
  legacyEntries: number; // rows with NULL tokenAddress (pre-Phase-2D USDC)
}

export interface TreasuryView {
  agentRegistryId: number;
  revenue: string; // total CREDIT
  costs: string; // total DEBIT (spends)
  subcontractorSpend: string;
  gas: string;
  escrowLocked: string;
  escrowPending: string;
  streamPending: string;
  treasuryBalance: string; // revenue - costs - escrowLocked
  availableBalance: string; // max(0, treasury - reserveMinimum)
  reserveMinimum: string;
  profit: string; // revenue - costs
  reinvestReserved: string; // computed, no fund movement
  received: string;
  sent: string;
  entryCount: number;
  pendingIncome: string;
  // Phase 2D: per-token accounting. Top-level totals above are preserved
  // byte-for-byte for backward compatibility (today USDC-only they equal the
  // USDC slice). When hasMixedTokens is true the top-level sums smallest
  // units across tokens and MUST NOT be read as a single-currency total
  // (never assume 1 EURC = 1 USDC) — consume byToken instead.
  byToken: Record<string, TokenSlice>;
  tokens: string[];
  hasMixedTokens: boolean;
  legacyEntryCount: number; // NULL-tokenAddress rows (all resolved as USDC)
  raw: {
    totalCredit: string;
    totalDebit: string;
    byType: Record<string, string>;
  };
}

export async function computeTreasuryView(agentRegistryId: number): Promise<TreasuryView> {
  const agent = await (prisma as any).agentRegistry.findUnique({
    where: { id: agentRegistryId },
    select: { id: true },
  });
  if (!agent) throw new Error(`agent ${agentRegistryId} not found`);

  const entries: any[] = await (prisma as any).agentLedgerEntry.findMany({
    where: { agentRegistryId },
    orderBy: { createdAt: "desc" },
  });

  let totalCredit = 0n;
  let totalDebit = 0n;
  const byType: Record<string, bigint> = {};
  let escrowLockedRaw = 0n;
  let subcontractorSpend = 0n;
  let gas = 0n;
  let streamPending = 0n;
  // Phase 2D per-token accumulators (native smallest units per token — never converted).
  const perToken = new Map<string, { revenue: bigint; costs: bigint; locked: bigint; count: number; legacy: number }>();
  let legacyEntryCount = 0;
  const touch = (sym: string) => {
    let s = perToken.get(sym);
    if (!s) { s = { revenue: 0n, costs: 0n, locked: 0n, count: 0, legacy: 0 }; perToken.set(sym, s); }
    return s;
  };

  for (const e of entries) {
    const amt = b(e.amount);
    const typ = String(e.type);
    const sym = rowSymbol(e);
    const slice = touch(sym);
    slice.count += 1;
    if (rowIsLegacy(e)) { slice.legacy += 1; legacyEntryCount += 1; }
    byType[typ] = (byType[typ] ?? 0n) + amt;
    // Escrow lock/release are NOT costs/revenue — they are liquidity reservation.
    // Counting them in totalDebit/CREDIT AND subtracting as escrowLocked double-counts.
    // Treasury economics must count the lock exactly once via escrowLocked.
    const isEscrowLock = typ === "JOB_ESCROW_LOCK" || typ === "JOB_ESCROW_RELEASE";
    if (!isEscrowLock) {
      if (e.direction === "CREDIT") { totalCredit += amt; slice.revenue += amt; }
      else { totalDebit += amt; slice.costs += amt; }
    }

    if (typ === "JOB_ESCROW_LOCK") { escrowLockedRaw += amt; slice.locked += amt; }
    if (typ === "JOB_ESCROW_RELEASE") { escrowLockedRaw -= amt; slice.locked -= amt; }
    if (typ === "SUBCONTRACTOR_SPEND") subcontractorSpend += amt;
    if (typ === "GAS") gas += amt;
  }
  if (escrowLockedRaw < 0n) escrowLockedRaw = 0n;

  // pending escrow from live jobs where agent is client and job is FUNDED (not yet completed)
  // ledger already tracks lock/release; we just ensure escrowLocked reflects ledger reality.
  // pending income: revenue that is in escrow but not yet released (for provider view)
  // Compute provider pending: funded jobs where agent is provider.
  let escrowPendingFromJobs = 0n;
  try {
    const sca = await (prisma as any).agentRegistry.findUnique({ where: { id: agentRegistryId }, select: { scaAddress: true } });
    if (sca?.scaAddress) {
      const fundedAsProvider: any[] = await (prisma as any).erc8183Job.findMany({
        where: { providerSCA: sca.scaAddress, status: { in: ["FUNDED", "SUBMITTED"] } },
        select: { budget: true },
      }).catch(() => []);
      for (const j of fundedAsProvider) escrowPendingFromJobs += BigInt(j.budget ?? 0);
    }
  } catch {}

  const revenue = totalCredit;
  const costs = totalDebit;
  const profit = revenue - costs;
  const treasuryBalance = revenue - costs - escrowLockedRaw;
  const policy: any = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId } }).catch(() => null);
  const reserveMinimum = policy ? b(policy.reserveMinimum) : 0n;
  let availableBalance = treasuryBalance - reserveMinimum;
  if (availableBalance < 0n) availableBalance = 0n;

  // reinvestReserved = reinvestPercent * confirmed revenue (since ledger start)
  const reinvestPercent = policy?.reinvestPercent ?? 0;
  let reinvestReserved = 0n;
  if (reinvestPercent > 0 && revenue > 0n) {
    reinvestReserved = (revenue * BigInt(reinvestPercent)) / 100n;
  }

  const fmt = (v: bigint) => v.toString();
  const byTypeStr: Record<string, string> = {};
  for (const [k, v] of Object.entries(byType)) byTypeStr[k] = v.toString();

  // Phase 2D: per-token slices with canonical identity. Slice balances are
  // clamped the same way as the top level (locked never negative per slice
  // only via the global clamp — per-slice locked is informational).
  const byToken: Record<string, TokenSlice> = {};
  for (const [sym, s] of perToken) {
    let addr = "";
    let dec = 6;
    try {
      const r = resolveRowCurrency({ currency: sym, tokenAddress: null });
      addr = r.address;
      dec = r.decimals;
    } catch {
      addr = tokenAddressFor("USDC");
    }
    // Prefer the canonical address actually seen on rows when available.
    const seen = entries.find((e: any) => rowSymbol(e) === sym && e?.tokenAddress);
    if (seen?.tokenAddress) addr = String(seen.tokenAddress);
    const bal = s.revenue - s.costs - (s.locked < 0n ? 0n : s.locked);
    byToken[sym] = {
      symbol: sym,
      tokenAddress: addr,
      decimals: dec,
      revenue: fmt(s.revenue),
      costs: fmt(s.costs),
      escrowLocked: fmt(s.locked < 0n ? 0n : s.locked),
      treasuryBalance: fmt(bal < 0n ? 0n : bal),
      entryCount: s.count,
      legacyEntries: s.legacy,
    };
  }
  const tokens = Object.keys(byToken).sort();

  return {
    agentRegistryId,
    revenue: fmt(revenue),
    costs: fmt(costs),
    subcontractorSpend: fmt(subcontractorSpend),
    gas: fmt(gas),
    escrowLocked: fmt(escrowLockedRaw),
    escrowPending: fmt(escrowPendingFromJobs),
    streamPending: fmt(streamPending),
    treasuryBalance: fmt(treasuryBalance < 0n ? 0n : treasuryBalance),
    availableBalance: fmt(availableBalance),
    reserveMinimum: fmt(reserveMinimum),
    profit: fmt(profit),
    reinvestReserved: fmt(reinvestReserved),
    received: fmt(totalCredit),
    sent: fmt(totalDebit),
    entryCount: entries.length,
    pendingIncome: fmt(escrowPendingFromJobs),
    byToken,
    tokens,
    hasMixedTokens: tokens.length > 1,
    legacyEntryCount,
    raw: {
      totalCredit: fmt(totalCredit),
      totalDebit: fmt(totalDebit),
      byType: byTypeStr,
    },
  };
}

export async function getRecentEntries(agentRegistryId: number, limit = 20): Promise<any[]> {
  return (prisma as any).agentLedgerEntry.findMany({
    where: { agentRegistryId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}
