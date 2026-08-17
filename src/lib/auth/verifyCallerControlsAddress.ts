/**
 * verifyCallerControlsAddress
 *
 * Fixes the standing audit finding: most wallet-execution routes currently
 * trust a wallet identifier passed in the request body instead of resolving
 * it from the authenticated caller. This helper is the single choke point
 * that should replace every `req.body.walletAddress` / `req.body.merchantId`
 * trust pattern across wallet-execution routes.
 *
 * Usage pattern (see bottom of file for a worked example):
 *   const check = await verifyCallerControlsAddress(req, claimedAddress, { role: "merchant" });
 *   if (!check.ok) return NextResponse.json({ error: check.reason }, { status: 403 });
 *
 * For two-party routes (escrow, streams, jobs with poster+worker), call this
 * TWICE — once to establish who the caller actually is, once to confirm the
 * claimed address matches the role they're trying to act as (poster vs worker).
 * Do NOT assume "caller resolved successfully" implies "caller is allowed to
 * do this specific action" — role-check separately.
 */

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma"; // adjust import path to match your existing prisma client location
import { resolveMerchant } from "@/lib/middleware/withMerchantAuth";
import { resolveConsumerSession } from "@/lib/middleware/withConsumerAuth";

export type CallerRole = "merchant" | "consumer" | "agent";

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  resolvedAddress?: string;
  callerId?: string;
  role?: CallerRole;
}

interface VerifyOptions {
  role: CallerRole;
}

/**
 * Resolves the authenticated caller's own wallet address from their session
 * token (merchant_token / consumer_token / agent-auth — never from req.body),
 * then compares it against the address the request claims to be acting as.
 */
export async function verifyCallerControlsAddress(
  req: NextRequest,
  claimedAddress: string,
  options: VerifyOptions
): Promise<VerifyResult> {
  const normalizedClaim = claimedAddress?.toLowerCase();
  if (!normalizedClaim) {
    return { ok: false, reason: "no claimed address provided" };
  }

  switch (options.role) {
    case "merchant": {
      const merchant = await resolveMerchantFromRequest(req);
      if (!merchant) return { ok: false, reason: "unauthenticated merchant" };

      const resolvedAddress = await getMerchantWalletAddress(merchant.id);
      if (!resolvedAddress) {
        return { ok: false, reason: "merchant has no resolvable wallet address" };
      }

      if (resolvedAddress.toLowerCase() !== normalizedClaim) {
        return {
          ok: false,
          reason: "claimed address does not match authenticated merchant's own wallet",
          resolvedAddress,
          callerId: merchant.id,
          role: "merchant",
        };
      }

      return { ok: true, resolvedAddress, callerId: merchant.id, role: "merchant" };
    }

    case "consumer": {
      const consumer = await resolveConsumerFromRequest(req);
      if (!consumer) return { ok: false, reason: "unauthenticated consumer" };

      const resolvedAddress = await getConsumerWalletAddress(consumer.id);
      if (!resolvedAddress) {
        return { ok: false, reason: "consumer has no resolvable wallet address" };
      }

      if (resolvedAddress.toLowerCase() !== normalizedClaim) {
        return {
          ok: false,
          reason: "claimed address does not match authenticated consumer's own wallet",
          resolvedAddress,
          callerId: consumer.id,
          role: "consumer",
        };
      }

      return { ok: true, resolvedAddress, callerId: consumer.id, role: "consumer" };
    }

    case "agent": {
      const agent = await resolveAgentFromRequest(req);
      if (!agent) return { ok: false, reason: "unauthenticated / unverified agent" };

      const resolvedAddress = agent.eoaAddress; // per-merchant AES-256-GCM encrypted EOA, already decrypted by resolveAgentFromRequest
      if (!resolvedAddress) {
        return { ok: false, reason: "agent has no resolvable x402 EOA wallet" };
      }

      if (resolvedAddress.toLowerCase() !== normalizedClaim) {
        return {
          ok: false,
          reason: "claimed address does not match authenticated agent's own EOA wallet",
          resolvedAddress,
          callerId: agent.id,
          role: "agent",
        };
      }

      return { ok: true, resolvedAddress, callerId: agent.id, role: "agent" };
    }

    default:
      return { ok: false, reason: "unknown role" };
  }
}

/**
 * ---- Resolution functions ----
 * Each delegates to the app's EXISTING auth architecture rather than
 * reimplementing auth here — the same auth every route already uses:
 *   - merchant: resolveMerchant() from withMerchantAuth (x-api-key or merchant_token cookie)
 *   - consumer: resolveConsumerSession() from withConsumerAuth (consumer_token cookie)
 *   - agent:    the app's only agent identities are the env-configured platform
 *               agent (AGENT_TOKEN_ID / AGENT_OWNER_WALLET_ADDRESS) reached via the
 *               real ApiKey-table service key (same check as resolveInitializeCaller's
 *               'internal' path), and registered agents (AgentRegistry) owned by an
 *               authenticated merchant.
 * This file deliberately does not invent a new auth mechanism — it just adds
 * the missing verification step on top of the auth you already have.
 */

interface MerchantPrincipal {
  id: string;
  email: string;
  businessName: string;
}

interface ConsumerPrincipal {
  id: string;
  walletAddress: string;
}

interface AgentPrincipal {
  id: string;
  eoaAddress: string | null;
}

async function resolveMerchantFromRequest(req: NextRequest): Promise<MerchantPrincipal | null> {
  return resolveMerchant(req);
}

async function resolveConsumerFromRequest(req: NextRequest): Promise<ConsumerPrincipal | null> {
  const walletAddress = await resolveConsumerSession(req);
  if (!walletAddress) return null;
  const consumer = await prisma.consumerAccount.findUnique({ where: { walletAddress } });
  // callerId = the DB row id when one exists; otherwise the wallet itself.
  return { id: consumer?.id ?? walletAddress, walletAddress };
}

async function resolveAgentFromRequest(req: NextRequest): Promise<AgentPrincipal | null> {
  // 1. Trusted server-to-server call (agent/brain) → the platform agent.
  //    Validated against the real ApiKey table — the exact check used by
  //    resolveInitializeCaller's 'internal' path. Never accepts an
  //    unauthenticated caller.
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const serviceKey = await (prisma as any).apiKey.findUnique({ where: { key: apiKey } });
    if (serviceKey && serviceKey.active) {
      const tokenId = process.env.AGENT_TOKEN_ID;
      const platformEoa = process.env.AGENT_OWNER_WALLET_ADDRESS;
      if (!tokenId || !platformEoa) return null; // agent identity not configured — fail closed
      return { id: tokenId, eoaAddress: platformEoa };
    }
  }

  // 2. A merchant acting for an agent they own (agents are deployed by
  //    merchants via /api/agent/deploy, which records AgentRegistry.merchantId).
  const merchant = await resolveMerchant(req);
  if (merchant) {
    const registry = await (prisma as any).agentRegistry.findFirst({
      where: { merchantId: merchant.id },
    });
    if (registry) {
      // Prefer the Agent row's EOA when one exists; otherwise the registered
      // owner/SCA wallet is the agent's identity wallet (same wallet the
      // brain route uses as the agent's payer).
      const agent = await prisma.agent.findFirst({ where: { registryId: registry.id } });
      return { id: String(registry.id), eoaAddress: agent?.walletAddress ?? registry.scaAddress ?? null };
    }
  }

  return null;
}

async function getMerchantWalletAddress(merchantId: string): Promise<string | null> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  return merchant?.walletAddress ?? null; // adjust field name to your schema
}

async function getConsumerWalletAddress(consumerId: string): Promise<string | null> {
  const consumer = await prisma.consumerAccount.findUnique({ where: { id: consumerId } });
  return consumer?.walletAddress ?? null; // adjust field name to your schema
}

/*
 * ---- Worked example: fixing a wallet-execution route ----
 *
 * BEFORE (vulnerable — trusts request body):
 *
 *   export async function POST(req: NextRequest) {
 *     const { walletAddress, amount } = await req.json();
 *     await executePayroll(walletAddress, amount); // <-- anyone can pass any address
 *   }
 *
 * AFTER:
 *
 *   export async function POST(req: NextRequest) {
 *     const { walletAddress, amount } = await req.json();
 *     const check = await verifyCallerControlsAddress(req, walletAddress, { role: "merchant" });
 *     if (!check.ok) {
 *       return NextResponse.json({ error: check.reason }, { status: 403 });
 *     }
 *     await executePayroll(check.resolvedAddress!, amount); // use the RESOLVED address, not the body's
 *   }
 *
 * Note the last line: always execute against `check.resolvedAddress`, not the
 * original `walletAddress` from the body, even after a passing check. This
 * removes any residual trust in client input.
 */
