// src/lib/ledger/treasuryService.ts
// Economic views derived from AgentLedgerEntry + live job escrow state.
// All totals are bigint (6-dec) internally, formatted as decimal strings in API.

import { prisma } from "@/lib/prisma";

function b(s: string | bigint): bigint {
  try { return BigInt(s as string); } catch { return 0n; }
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

  for (const e of entries) {
    const amt = b(e.amount);
    const typ = String(e.type);
    byType[typ] = (byType[typ] ?? 0n) + amt;
    // Escrow lock/release are NOT costs/revenue — they are liquidity reservation.
    // Counting them in totalDebit/CREDIT AND subtracting as escrowLocked double-counts.
    // Treasury economics must count the lock exactly once via escrowLocked.
    const isEscrowLock = typ === "JOB_ESCROW_LOCK" || typ === "JOB_ESCROW_RELEASE";
    if (!isEscrowLock) {
      if (e.direction === "CREDIT") totalCredit += amt;
      else totalDebit += amt;
    }

    if (typ === "JOB_ESCROW_LOCK") escrowLockedRaw += amt;
    if (typ === "JOB_ESCROW_RELEASE") escrowLockedRaw -= amt;
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
