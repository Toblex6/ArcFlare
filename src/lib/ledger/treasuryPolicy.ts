// src/lib/ledger/treasuryPolicy.ts
// Per-agent treasury policy: reserveMinimum, caps, auto flags.
// Fail-closed evaluation before autonomous spend.

import { prisma } from "@/lib/prisma";
import { computeTreasuryView } from "./treasuryService";

export interface PolicyInput {
  reserveMinimum?: string; // 6-dec bigint string
  maxSpendPerJob?: string;
  maxSpendPerDay?: string;
  maxSubcontractorSpendPerDay?: string;
  autoPaySubcontractors?: boolean;
  reinvestPercent?: number;
}

export async function getOrCreatePolicy(agentRegistryId: number): Promise<any> {
  let p = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId } });
  if (!p) {
    p = await (prisma as any).agentTreasuryPolicy.create({
      data: { agentRegistryId },
    });
  }
  return p;
}

export async function upsertPolicy(agentRegistryId: number, input: PolicyInput): Promise<any> {
  const data: any = {};
  if (input.reserveMinimum !== undefined) {
    if (!/^\d+$/.test(String(input.reserveMinimum))) throw new Error("reserveMinimum must be integer string (6-dec units)");
    data.reserveMinimum = String(input.reserveMinimum);
  }
  if (input.maxSpendPerJob !== undefined) {
    if (!/^\d+$/.test(String(input.maxSpendPerJob))) throw new Error("maxSpendPerJob must be integer string");
    data.maxSpendPerJob = String(input.maxSpendPerJob);
  }
  if (input.maxSpendPerDay !== undefined) {
    if (!/^\d+$/.test(String(input.maxSpendPerDay))) throw new Error("maxSpendPerDay must be integer string");
    data.maxSpendPerDay = String(input.maxSpendPerDay);
  }
  if (input.maxSubcontractorSpendPerDay !== undefined) {
    if (!/^\d+$/.test(String(input.maxSubcontractorSpendPerDay))) throw new Error("maxSubcontractorSpendPerDay must be integer string");
    data.maxSubcontractorSpendPerDay = String(input.maxSubcontractorSpendPerDay);
  }
  if (input.autoPaySubcontractors !== undefined) data.autoPaySubcontractors = !!input.autoPaySubcontractors;
  if (input.reinvestPercent !== undefined) {
    const v = Number(input.reinvestPercent);
    if (!Number.isInteger(v) || v < 0 || v > 100) throw new Error("reinvestPercent must be integer 0..100");
    data.reinvestPercent = v;
  }
  return (prisma as any).agentTreasuryPolicy.upsert({
    where: { agentRegistryId },
    create: { agentRegistryId, ...data },
    update: data,
  });
}

export async function evaluatePolicyForSpend(params: {
  agentRegistryId: number;
  amount: bigint; // 6-dec
  kind?: "job" | "subcontractor" | "generic";
}): Promise<{ allowed: boolean; reason: string }> {
  const policy: any = await (prisma as any).agentTreasuryPolicy.findUnique({ where: { agentRegistryId: params.agentRegistryId } });
  // No policy => fail open for amount but reserve-aware: require treasury exists
  const view = await computeTreasuryView(params.agentRegistryId);
  const treasury = BigInt(view.treasuryBalance);
  const available = BigInt(view.availableBalance);
  const amount = params.amount;

  if (policy) {
    const reserve = BigInt(policy.reserveMinimum ?? "0");
    // available already = treasury - reserve, but check explicit
    if (treasury - amount < reserve) {
      return { allowed: false, reason: `would breach reserveMinimum ${reserve} (treasury ${treasury}, spend ${amount})` };
    }
    const maxPerJob = BigInt(policy.maxSpendPerJob ?? "0");
    if (maxPerJob > 0n && amount > maxPerJob) {
      return { allowed: false, reason: `amount ${amount} exceeds maxSpendPerJob ${maxPerJob}` };
    }
    // daily caps: sum DEBIT entries in last 24h of relevant type
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (policy.maxSpendPerDay && BigInt(policy.maxSpendPerDay) > 0n) {
      const entries: any[] = await (prisma as any).agentLedgerEntry.findMany({
        where: { agentRegistryId: params.agentRegistryId, direction: "DEBIT", createdAt: { gte: since } },
      });
      let spentToday = 0n;
      for (const e of entries) spentToday += BigInt(e.amount);
      if (spentToday + amount > BigInt(policy.maxSpendPerDay)) {
        return { allowed: false, reason: `would exceed maxSpendPerDay ${policy.maxSpendPerDay} (spent ${spentToday} today)` };
      }
    }
    if (params.kind === "subcontractor" && policy.maxSubcontractorSpendPerDay && BigInt(policy.maxSubcontractorSpendPerDay) > 0n) {
      const entries: any[] = await (prisma as any).agentLedgerEntry.findMany({
        where: { agentRegistryId: params.agentRegistryId, type: "SUBCONTRACTOR_SPEND", createdAt: { gte: since } },
      });
      let spent = 0n;
      for (const e of entries) spent += BigInt(e.amount);
      if (spent + amount > BigInt(policy.maxSubcontractorSpendPerDay)) {
        return { allowed: false, reason: `would exceed maxSubcontractorSpendPerDay ${policy.maxSubcontractorSpendPerDay} (spent ${spent})` };
      }
    }
  }

  if (available < amount) {
    return { allowed: false, reason: `insufficient available balance ${available} for spend ${amount} (treasury ${treasury})` };
  }
  return { allowed: true, reason: "policy allows" };
}
