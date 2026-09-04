// /api/agent/deploy/recover/route.ts
//
// Smallest safe recovery endpoint for the ERC-8004 "register() succeeded but
// the server lost the response / could not recover the tokenId" window
// (see deploy/route.ts §6 which returns PENDING_IDENTITY_CONFIRMATION and
// persists NO AgentRegistry row).
//
// Given the txHash of an already-confirmed registration, this endpoint:
//   - requires merchant authentication (withMerchantAuth),
//   - derives the REAL identity (recipient + tokenId) from AUTHORITATIVE
//     on-chain receipt logs — never from the request body,
//   - refuses if the recipient is not an address the authenticated merchant
//     controls (getCallerControlledAddresses — the repo's single ownership
//     gate; never trusts ownerAddress alone),
//   - refuses cross-merchant conflicts, is idempotent, never mints wallets,
//     never submits a second registration, and reuses the deploy route's
//     successful persistence path.

import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { withMerchantAuth, AuthedMerchant } from "@/src/lib/middleware/withMerchantAuth";
import { getCallerControlledAddresses } from "@/src/lib/wallet/verifyCallerControlsAddress";
import { extractIdentityMintFromLogs } from "@/src/lib/agents/agentRegisterRecovery";

const prisma = new PrismaClient();

// Same authoritative registry the deploy route registers against.
const IDENTITY_REGISTRY =
  process.env.IDENTITY_REGISTRY_ADDRESS || "0x8004A818BFB912233c491871b3d84c89A494BD9e";

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function recoverAgentHandler(request: Request, merchant: AuthedMerchant) {
  try {
    const body = await request.json().catch(() => ({}));
    const txHash = String(body?.txHash ?? "").trim();

    // 1. The recovery identifier is the on-chain tx — a body-supplied tokenId
    // or owner address alone is never trusted (requirement: txHash preferred,
    // no fabricated tokenIds).
    if (!TX_HASH_RE.test(txHash)) {
      return NextResponse.json(
        { error: "txHash is required and must be a 0x-prefixed 64-hex transaction hash." },
        { status: 400 }
      );
    }

    // 2. Pull the authoritative receipt from Arc (retry transient RPC flakes —
    // testnet nodes are intermittently out of sync; don't assume failure).
    const publicClient = createPublicClient({ chain: arcTestnet, transport: http() });
    let receipt: any = null;
    for (let attempt = 1; attempt <= 3 && !receipt; attempt++) {
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      } catch {
        if (attempt < 3) await sleep(1500 * attempt);
      }
    }
    if (!receipt) {
      return NextResponse.json(
        { error: "Transaction receipt not found on chain." },
        { status: 404 }
      );
    }

    // 3. Derive the REAL identity (holder + tokenId) from this tx's logs.
    const mint = extractIdentityMintFromLogs(receipt.logs as any, IDENTITY_REGISTRY);
    if (!mint) {
      return NextResponse.json(
        {
          error:
            "This transaction did not mint an ERC-8004 identity to a single holder (no registry Transfer-from-zero log) — refusing to guess a tokenId.",
          txHash,
        },
        { status: 422 }
      );
    }

    // 4. Ownership: the minted identity must be held by an address the
    // authenticated merchant provably controls. This is what stops a merchant
    // from attaching another merchant's registration (the recovered SCA is
    // matched against the same trust set used everywhere else).
    const controlled = await getCallerControlledAddresses(request as any);
    const toLower = mint.to.toLowerCase();
    if (!controlled.has(toLower)) {
      return NextResponse.json(
        {
          error:
            "The recovered identity is held by an address this merchant does not control. This registration cannot be attached to your account.",
          txHash,
          recoveredHolder: mint.to,
        },
        { status: 403 }
      );
    }
// 5. Idempotency + cross-merchant protection, resolved BEFORE any write.
    const existingByToken = await (prisma as any).agentRegistry.findUnique({
      where: { tokenId: mint.tokenId },
    });
    const existingBySca = await (prisma as any).agentRegistry.findUnique({
      where: { scaAddress: mint.to },
    });
    const existing = existingByToken ?? existingBySca;
    if (existing) {
      if (existing.merchantId && existing.merchantId !== merchant.id) {
        return NextResponse.json(
          {
            error: "This ERC-8004 identity (tokenId / holder) already belongs to a different merchant.",
            txHash,
          },
          { status: 409 }
        );
      }
      // Already this merchant's agent (or a legacy row) — idempotent replay.
      return NextResponse.json({
        success: true,
        replayed: true,
        agent: existing,
        txHash,
        registry: IDENTITY_REGISTRY,
      });
    }

    // 6. Persist via the SAME successful-deployment path as deploy/route.ts §7.
    // No wallet provisioning and no second registration happen here — only a
    // DB record for an identity already minted on-chain.
    let created: any;
    try {
      created = await (prisma as any).agentRegistry.create({
        data: {
          name: `Recovered Agent #${mint.tokenId}`,
          tokenId: mint.tokenId,
          scaAddress: mint.to,
          circleWalletId: null, // unknown from chain data (see report: recovered agents may need a wallet re-link)
          ownerNode: "0xAgenticNodeOperatorDefaultAddress",
          status: "ACTIVE_AGENT_PROVISIONED",
          merchantId: merchant.id,
          description: `Recovered from on-chain registration tx ${txHash}`,
        },
      });
    } catch (e: any) {
      // A concurrent recovery (or an earlier fast-path race) hit a @unique
      // constraint — re-read and return the row if it's this merchant's.
      if (e?.code === "P2002") {
        const after = await (prisma as any).agentRegistry.findUnique({
          where: { tokenId: mint.tokenId },
        });
        if (after && (!after.merchantId || after.merchantId === merchant.id)) {
          return NextResponse.json({
            success: true,
            replayed: true,
            agent: after,
            txHash,
            registry: IDENTITY_REGISTRY,
          });
        }
        return NextResponse.json(
          { error: "This ERC-8004 identity was already claimed by another merchant.", txHash },
          { status: 409 }
        );
      }
      throw e;
    }

    return NextResponse.json({
      success: true,
      agent: created,
      txHash,
      registry: IDENTITY_REGISTRY,
    });
  } catch (error: any) {
    console.error("❌ API Error [deploy/recover]:", error);
    return NextResponse.json({ error: error?.message || "Internal Server Error" }, { status: 500 });
  }
}

export const POST = withMerchantAuth(recoverAgentHandler as any);