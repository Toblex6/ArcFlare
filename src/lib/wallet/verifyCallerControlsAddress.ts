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
    const ownedAgents = await (prisma as any).agentRegistry.findMany({
      where: { merchantId: merchant.id },
    });
    const ownedAgent = ownedAgents.find(
      (a: any) => a.scaAddress?.toLowerCase() === normalized
    );
    if (ownedAgent) {
      return { type: "merchant", id: merchant.id, walletAddress: ownedAgent.scaAddress };
    }
    // And a merchant controls its agents' payment EOAs (x402_eoa_wallets
    // rows keyed by agentRegistryId — the wallets agent-to-agent payments
    // are signed from, same trust boundary as the buyer EOA above).
    const agentPaymentEoa = await (prisma as any).x402EoaWallet.findFirst({
      where: {
        agentRegistryId: { in: ownedAgents.map((a: any) => a.id) },
        address: { equals: claimedAddress, mode: "insensitive" },
      },
    });
    if (agentPaymentEoa) {
      return { type: "merchant", id: merchant.id, walletAddress: agentPaymentEoa.address };
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

  // Agent (identified by internal service ApiKey — the ApiKey table holds
  // SERVICE keys only; merchant keys live on the Merchant row and are
  // resolved by resolveMerchant above, so this branch is only ever reached
  // with an internal key).
  //
  // An API key does NOT grant control of an arbitrary AgentRegistry address.
  // Control comes from an explicit authenticated owner/agent context tied to
  // the merchant/agent relationship. The internal service key may therefore
  // act as exactly ONE agent: the platform's own (AGENT_OWNER_WALLET_ADDRESS).
  // Any other claimed address — a tenant's agent, a consumer wallet, a
  // merchant's agent — returns null and the caller rejects the request.
  // (Previously any active ApiKey could claim ANY AgentRegistry SCA, which
  // let an LLM prompt schedule recurring debits or job execution against
  // another tenant's agent wallet — the cross-tenant agent-control exploit.)
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const keyRecord = await (prisma as any).apiKey.findUnique({ where: { key: apiKey } });
    // Deactivated keys must not impersonate agents.
    if (keyRecord && keyRecord.active) {
      const platformAgent = (process.env.AGENT_OWNER_WALLET_ADDRESS || "").toLowerCase();
      if (platformAgent && normalized === platformAgent) {
        const agent = await (prisma as any).agentRegistry.findFirst({
          where: { scaAddress: { equals: claimedAddress, mode: "insensitive" } },
        });
        if (agent) {
          return { type: "agent", id: String(agent.id), walletAddress: agent.scaAddress };
        }
        // The platform agent address with no registry row is still the
        // internal key's own identity — the key IS its credential.
        return { type: "agent", id: "platform", walletAddress: platformAgent };
      }
    }
  }

  return null;
}

/**
 * Enumerates EVERY address the authenticated caller controls — the
 * set-valued counterpart to verifyCallerControlsAddress above.
 *
 * Needed by list-style endpoints (e.g. GET /api/payments/scheduled): a
 * per-row control check against one claimed address can't answer "show me
 * all my schedules," and probing each row's payer through the single-
 * address verifier is N+1 queries. Same trust boundaries, same actor
 * branches — just collected up-front instead of tested per claim.
 */
export async function getCallerControlledAddresses(
  req: NextRequest
): Promise<Set<string>> {
  const addresses = new Set<string>();
  const add = (a?: string | null) => {
    if (a) addresses.add(a.toLowerCase());
  };

  // Merchant: own wallet, buyer EOA, owned agents' SCAs, agents' payment EOAs.
  const merchant = await resolveMerchant(req).catch(() => null);
  if (merchant) {
    const record = await (prisma as any).merchant.findUnique({
      where: { id: merchant.id },
      select: { walletAddress: true },
    });
    add(record?.walletAddress);

    const buyerWallet = await (prisma as any).x402EoaWallet.findUnique({
      where: { merchantId: merchant.id },
      select: { address: true },
    });
    add(buyerWallet?.address);

    const ownedAgents = await (prisma as any).agentRegistry.findMany({
      where: { merchantId: merchant.id },
      select: { id: true, scaAddress: true },
    });
    for (const agent of ownedAgents) add(agent.scaAddress);

    if (ownedAgents.length > 0) {
      const paymentEoas = await (prisma as any).x402EoaWallet.findMany({
        where: { agentRegistryId: { in: ownedAgents.map((a: any) => a.id) } },
        select: { address: true },
      });
      for (const eoa of paymentEoas) add(eoa.address);
    }
  }

  // Consumer session (JWT carries the wallet address).
  const consumerWalletAddress = await resolveConsumerSession(req).catch(() => null);
  add(consumerWalletAddress);

  // Internal service key acts as exactly ONE agent: the platform's own.
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const keyRecord = await (prisma as any).apiKey.findUnique({ where: { key: apiKey } });
    if (keyRecord && keyRecord.active) {
      const platformAgent = (process.env.AGENT_OWNER_WALLET_ADDRESS || "").toLowerCase();
      if (platformAgent) add(platformAgent);
    }
  }

  return addresses;
}
