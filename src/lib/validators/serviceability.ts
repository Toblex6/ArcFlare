// src/lib/validators/serviceability.ts
// M1 — shared validator serviceability gate. A validation-required hire
// stores a validatorSCA that must later sign a Circle-signed
// validationResponse. An external/non-Circle wallet could never respond,
// permanently blocking provider payout. This helper is the single authority
// used by all three hire routes (agents/[id]/hire, treasury/hire,
// procurement/[id]/hire): it requires CIRCLE custody (merchant
// walletProvider / consumer walletType === 'CIRCLE' plus a bound
// circleWalletId; agents are Circle-managed by construction so the bound id
// suffices) AND a live getWallet address match, so a stale/forged binding
// fails closed before any side effect.

import { prisma } from "@/lib/prisma";

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export async function assertValidatorServiceable(
  validatorSCA: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!ADDRESS_RE.test(String(validatorSCA ?? ""))) {
    return { ok: false, error: "validation.validatorSCA must be valid 0x address" };
  }
  const sca = String(validatorSCA);
  const [merchant, agent, consumer] = await Promise.all([
    (prisma as any).merchant.findFirst({
      where: { walletAddress: { equals: sca, mode: "insensitive" } },
      select: { walletProvider: true, circleWalletId: true, walletAddress: true },
    }),
    (prisma as any).agentRegistry.findFirst({
      where: { scaAddress: { equals: sca, mode: "insensitive" } },
      select: { circleWalletId: true, scaAddress: true },
    }),
    (prisma as any).consumerAccount.findFirst({
      where: { walletAddress: { equals: sca, mode: "insensitive" } },
      select: { walletType: true, circleWalletId: true, walletAddress: true },
    }),
  ]);

  // M1: custody first — id-presence alone is not enough.
  const merchantCustodied =
    merchant?.walletProvider === "CIRCLE" && !!merchant?.circleWalletId && !!merchant?.walletAddress;
  const agentCustodied = !!agent?.circleWalletId;
  const consumerCustodied =
    String(consumer?.walletType ?? "").toUpperCase() === "CIRCLE" &&
    !!consumer?.circleWalletId &&
    !!consumer?.walletAddress;
  if (!merchantCustodied && !agentCustodied && !consumerCustodied) {
    return {
      ok: false,
      error:
        "validatorSCA must be a Circle-managed wallet capable of signing a validation response — external wallets cannot respond to validation requests.",
    };
  }

  // M1: live getWallet address match — a stale binding fails closed.
  const walletId =
    (merchantCustodied ? merchant.circleWalletId : null) ??
    (agentCustodied ? agent.circleWalletId : null) ??
    (consumerCustodied ? consumer.circleWalletId : null);
  try {
    const { getCircleClient } = await import("@/lib/circle/client");
    const w = await getCircleClient().getWallet({ id: walletId });
    const live = String(w.data?.wallet?.address ?? "");
    if (!live || live.toLowerCase() !== sca.toLowerCase()) {
      return {
        ok: false,
        error:
          "validatorSCA Circle binding does not match the live wallet address — refusing a hire that could never validate.",
      };
    }
  } catch {
    return {
      ok: false,
      error:
        "validatorSCA Circle wallet is not resolvable right now — refusing a hire that cannot be proven serviceable.",
    };
  }
  return { ok: true };
}
