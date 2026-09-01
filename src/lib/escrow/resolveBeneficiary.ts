// src/lib/escrow/resolveBeneficiary.ts
//
// Classifies an escrow beneficiary address at creation time so notifications,
// the Incoming-escrows list, and the external-EOA confirm page never need to
// re-resolve the same wallet with N+1 lookups. Stored on the Escrow row as
// `beneficiaryKind`:
//
//   merchant  → a Merchant.walletAddress            (FlareHQ actor)
//   consumer  → a ConsumerAccount.walletAddress     (FlareHQ actor)
//   agent     → an AgentRegistry.scaAddress         (controlled by its owner merchant)
//   external  → anyone else (plain EOA / contract / typo) — gets the public
//               confirm link path
//
// Lookups are intentionally multi-`findFirst` (not exhaustive) — the goal is a
// best-effort classification, and a wallet that matches nothing is `external`,
// which is a fully supported first-class case, not an error.

import { prisma } from "@/lib/prisma";

export type BeneficiaryKind = "merchant" | "consumer" | "agent" | "external";

export interface ResolvedBeneficiary {
  kind: BeneficiaryKind;
  /** Stable unique id of the resolved actor (merchant uuid, consumer uuid, agent id) — null for external. */
  actorId: string | null;
  /** Human-friendly name for notifications (business name, consumer wallet, agent name) — best-effort. */
  name: string | null;
  /** The beneficiary wallet address as stored (checksummed where known). */
  address: string;
}

export async function resolveBeneficiary(address: string): Promise<ResolvedBeneficiary> {
  const lower = address.toLowerCase();

  const merchant = await (prisma as any).merchant.findFirst({
    where: { walletAddress: { equals: address, mode: "insensitive" } },
    select: { id: true, businessName: true, walletAddress: true },
  });
  if (merchant) {
    return { kind: "merchant", actorId: merchant.id, name: merchant.businessName || null, address: merchant.walletAddress };
  }

  const consumer = await (prisma as any).consumerAccount.findFirst({
    where: { walletAddress: { equals: address, mode: "insensitive" } },
    select: { id: true, walletAddress: true },
  });
  if (consumer) {
    return { kind: "consumer", actorId: consumer.id, name: consumer.walletAddress, address: consumer.walletAddress };
  }

  const agent = await (prisma as any).agentRegistry.findFirst({
    where: { scaAddress: { equals: address, mode: "insensitive" } },
    select: { id: true, name: true, scaAddress: true, merchantId: true },
  });
  if (agent) {
    return { kind: "agent", actorId: String(agent.id), name: agent.name || null, address: agent.scaAddress };
  }

  // No match anywhere → external. (Keep the caller's original case; only the
  // store-normalized lower form exists above.)
  return { kind: "external", actorId: null, name: null, address: lower };
}

/**
 * Build the public beneficiary-confirmation URL for an escrow. External-EOA
 * beneficiaries confirm on this page; FlareHQ actors get the in-app Incoming
 * list but the link is still returned so a depositor can share it either way.
 */
export function beneficiaryConfirmUrl(reference: string): string {
  return `${process.env.NEXT_PUBLIC_BASE_URL || "https://flarehq.xyz"}/escrow-confirm/${reference}`;
}
