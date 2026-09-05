// /api/agent/deploy/recover/route.ts
//
// ERC-8004 deployment recovery for the "register() succeeded but the server lost
// the response / could not recover the tokenId" window (deploy/route.ts §6
// returns PENDING_IDENTITY_CONFIRMATION and persists NO AgentRegistry row).
//
// SECURITY MODEL (deploy-intent binding — NOT getCallerControlledAddresses):
// The deploy route persists a SERVER-SIDE `AgentDeployIntent` (merchantId +
// Circle walletSetId + ownerSca + validatorSca, all server-derived) BEFORE it
// submits the ERC-8004 register(). This endpoint therefore never trusts a
// client-supplied walletSetId / ownerAddress / validatorSca / tokenId /
// merchantId. To recover a txHash it must prove BOTH:
//   1. the tx is a real ERC-8004 registration mint (identity registry, ERC-721
//      mint from the zero address, positive tokenId) whose holder equals the
//      ownerSca recorded in ONE of the authenticated merchant's deploy intents,
//   AND
//   2. that holder SCA actually belongs to the Circle wallet set stored on that
//      server-side intent (verified with Circle's read-only listWallets).
// It NEVER provisions Circle wallets and NEVER submits a second registration.

import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { withMerchantAuth, AuthedMerchant } from "@/src/lib/middleware/withMerchantAuth";
import {
  extractIdentityMintFromLogs,
  matchDeployIntentToMint,
} from "@/src/lib/agents/agentRegisterRecovery";

const prisma = new PrismaClient();

// Same authoritative registry the deploy route registers against.
const IDENTITY_REGISTRY =
  process.env.IDENTITY_REGISTRY_ADDRESS || "0x8004A818BFB912233c491871b3d84c89A494BD9e";

const TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Best-effort intent status update. A success path never fails because the
// bookkeeping update hiccups — the authoritative write is the AgentRegistry
// row, and an un-marked intent is still replayed idempotently next time.
const markIntent = (id: string, patch: Record<string, unknown>) =>
  (prisma as any).agentDeployIntent
    .update({ where: { id }, data: patch })
    .catch(() => {});

async function recoverAgentHandler(request: Request, merchant: AuthedMerchant) {
  try {
    const body = await request.json().catch(() => ({}));
    const txHash = String(body?.txHash ?? "").trim();

    // 1. The recovery identifier is the on-chain tx. A body-supplied tokenId,
    // walletSetId, ownerAddress, merchantId or validatorSca is NEVER read here
    // (no fabricated tokenIds, no client-side ownership claims).
    if (!TX_HASH_RE.test(txHash)) {
      return NextResponse.json(
        { error: "txHash is required and must be a 0x-prefixed 64-hex transaction hash." },
        { status: 400 }
      );
    }

    // 2. Authoritative binding: the merchant's server-side deploy intents. If
    // this merchant has none, no tx can be attached — refuse up front (the
    // deploy route creates an intent BEFORE registering, so a legitimately
    // orphaned registration always has one).
    const intents: any[] = await (prisma as any).agentDeployIntent.findMany({
      where: { merchantId: merchant.id },
      orderBy: { createdAt: "asc" },
    });
    if (intents.length === 0) {
      return NextResponse.json(
        {
          error:
            "No server-side deployment record exists for this merchant, so no on-chain registration can be proven as yours. Start a deployment through POST /api/agent/deploy instead.",
          txHash,
        },
        { status: 403 }
      );
    }

    // 3. Pull the authoritative receipt from Arc (retry transient RPC flakes —
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

    // 4. Prove the tx is the expected ERC-8004 registration/mint. The pure
    // extractor enforces: emitting contract === identity registry, ERC-721
    // Transfer with from === zero address (a mint, not a later transfer), a
    // well-formed holder and a positive real tokenId. Anything else → null.
    const mint = extractIdentityMintFromLogs(receipt.logs as any, IDENTITY_REGISTRY);
    if (!mint) {
      return NextResponse.json(
        {
          error:
            "This transaction did not mint an ERC-8004 identity to a single holder from the identity registry (no registry Transfer-from-zero log) — refusing to guess a tokenId.",
          txHash,
        },
        { status: 422 }
      );
    }

    // 5. Bind the minted holder to this merchant's deploy intent(s). The
    // holder must equal an intent's recorded ownerSca; when an intent already
    // recorded this exact txHash as its registerTxHash, prefer it. No match =
    // another merchant's (or unrelated) tx → refuse.
    const intent = matchDeployIntentToMint(intents, mint.to, txHash);
    if (!intent) {
      return NextResponse.json(
        {
          error:
            "The identity minted by this transaction is not bound to any deployment this merchant has server-side. It cannot be attached to your account.",
          txHash,
          recoveredHolder: mint.to,
        },
        { status: 403 }
      );
    }

    // 5b. Idempotent replay: an AgentRegistry row may already exist for this
    // token/SCA (normal deploy completed, or an earlier recovery won). Return
    // it when it is this merchant's; never duplicate.
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
      await markIntent(intent.id, { status: "COMPLETED" });
      return NextResponse.json({
        success: true,
        replayed: true,
        agent: existing,
        txHash,
        registry: IDENTITY_REGISTRY,
      });
    }

    // 6. Circle proof (read-only listWallets on the SERVER-STORED walletSetId):
    // the minted holder must actually be a wallet in the wallet set recorded on
    // this merchant's deploy intent. Client-supplied walletSetId is never used.
    // If Circle cannot be reached the recovery is refused — never assumed.
    if (!process.env.CIRCLE_API_KEY || !process.env.CIRCLE_ENTITY_SECRET) {
      return NextResponse.json(
        { error: "Circle credentials unavailable — cannot verify wallet-set membership." },
        { status: 503 }
      );
    }
    const circleClient = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
    const mintToLower = mint.to.toLowerCase();
    let holderInWalletSet = false;
    for (let attempt = 1; attempt <= 3 && !holderInWalletSet; attempt++) {
      try {
        const { data } = await circleClient.listWallets({ walletSetId: intent.walletSetId });
        holderInWalletSet = (data?.wallets ?? []).some(
          (w: any) => w?.address && String(w.address).toLowerCase() === mintToLower
        );
      } catch {
        if (attempt < 3) await sleep(1500 * attempt);
      }
    }
    if (!holderInWalletSet) {
      return NextResponse.json(
        {
          error:
            "The identity holder is not a wallet in this deployment's recorded Circle wallet set. This registration cannot be attached to your account.",
          txHash,
          recoveredHolder: mint.to,
        },
        { status: 403 }
      );
    }

    // 7. Persist the real identity via the SAME successful-deployment shape as
    // deploy/route.ts §7, carrying the server-stored walletSetId, validatorSca
    // and owner circleWalletId from the intent. No wallet provisioning and no
    // second registration happen here — only a DB record for an identity
    // already minted on-chain.
    let created: any;
    try {
      created = await (prisma as any).agentRegistry.create({
        data: {
          name: `Recovered Agent #${mint.tokenId}`,
          tokenId: mint.tokenId,
          scaAddress: mint.to,
          circleWalletId: intent.circleWalletId ?? null,
          walletSetId: intent.walletSetId,
          validatorSca: intent.validatorSca,
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
        const after = await (prisma as any).agentRegistry.findFirst({
          where: {
            OR: [{ tokenId: mint.tokenId }, { scaAddress: mint.to }],
          },
        });
        if (after && (!after.merchantId || after.merchantId === merchant.id)) {
          await markIntent(intent.id, { status: "COMPLETED" });
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

    await markIntent(intent.id, {
      status: "COMPLETED",
      ...(intent.registerTxHash ? {} : { registerTxHash: txHash }),
    });

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
