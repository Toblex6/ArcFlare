// src/lib/wallet/verifyCallerControlsAddress.ts
//
// The missing check underneath Escrow, Streams, and the ERC-8183 job
// routes: none of them currently prove the caller actually controls the
// address they claim to be (depositorSCA, beneficiarySCA, callerSCA,
// senderSCA, receiverSCA, clientWalletId, providerWalletId, etc.) — they
// just trust the string in the request body. This is the generic fix,
// used by every two/multi-party route instead of each reinventing its own
// version of "is this really you."
//
// A caller can be a Merchant, a ConsumerAccount, or an Agent (AgentRegistry)
// — three actor types, not one, which is why this doesn't live inside
// resolveWalletProvider(). It answers "does this authenticated caller
// control this address," not "which WalletProvider does this address use."

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { resolveConsumerSession } from "@/lib/middleware/withConsumerAuth";

export type ControllingActor =
  | { type: "merchant"; id: string; walletAddress: string }
  | { type: "consumer"; id: string; walletAddress: string }
  | { type: "agent"; id: string; walletAddress: string };

/**
 * Verifies the authenticated caller (merchant, consumer, or agent session/
 * API key) actually controls `claimedAddress`. Returns the matching actor
 * if so, or null if the caller has no session at all, or the address
 * doesn't match anything they own. Callers should treat null as "reject
 * the request" — never fall back to trusting claimedAddress anyway.
 */
export async function verifyCallerControlsAddress(
  req: NextRequest,
  claimedAddress: string
): Promise<ControllingActor | null> {
  const normalized = claimedAddress.toLowerCase();

  // Merchant session (API key or dashboard cookie)
  const merchant = await resolveMerchant(req).catch(() => null);
  if (merchant) {
    const record = await (prisma as any).merchant.findUnique({ where: { id: merchant.id } });
    if (record?.walletAddress?.toLowerCase() === normalized) {
      return { type: "merchant", id: merchant.id, walletAddress: record.walletAddress };
    }
    // A merchant also controls its auto-provisioned x402 buyer EOA (the
    // wallet GatewayClient.pay() signs x402 payments from — the merchant's
    // encrypted key is stored in x402_eoa_wallets). Without this, a merchant
    // paying via its buyer EOA would fail caller-control on x402-settled
    // routes (e.g. payroll funding).
    const buyerWallet = await (prisma as any).x402EoaWallet.findUnique({
      where: { merchantId: merchant.id },
      select: { address: true },
    });
    if (buyerWallet?.address?.toLowerCase() === normalized) {
      return { type: "merchant", id: merchant.id, walletAddress: buyerWallet.address };
    }
    // A merchant also controls any agent they deployed (AgentRegistry rows
    // carry the owning merchantId). This is what lets a merchant operate
    // their own agents' wallets without holding a service key, while an
    // unrelated merchant's agent stays out of reach.
    const ownedAgent = await (prisma as any).agentRegistry.findFirst({
      where: {
        merchantId: merchant.id,
        scaAddress: { equals: claimedAddress, mode: "insensitive" },
      },
    });
    if (ownedAgent) {
      return { type: "merchant", id: merchant.id, walletAddress: ownedAgent.scaAddress };
    }
  }

  // Consumer session (wallet-first, consumer_token cookie — the JWT itself
  // carries the wallet address, no separate object to unwrap).
  const consumerWalletAddress = await resolveConsumerSession(req).catch(() => null);
  if (consumerWalletAddress && consumerWalletAddress.toLowerCase() === normalized) {
    const record = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress: consumerWalletAddress },
    });
    if (record) {
      return { type: "consumer", id: record.id, walletAddress: record.walletAddress };
    }
  }

  // Agent (identified by internal service ApiKey + an agentId the caller
  // asserts — the ApiKey proves "you're a legitimate service caller," the
  // AgentRegistry lookup proves "this SCA really belongs to that agent.")
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const keyRecord = await (prisma as any).apiKey.findUnique({ where: { key: apiKey } });
    // Deactivated keys must not impersonate agents.
    if (keyRecord && keyRecord.active) {
      const agent = await (prisma as any).agentRegistry.findFirst({
        where: { scaAddress: { equals: claimedAddress, mode: "insensitive" } },
      });
      if (agent) {
        return { type: "agent", id: String(agent.id), walletAddress: agent.scaAddress };
      }
    }
  }

  return null;
}
