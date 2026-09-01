// src/app/api/agent/reputation/route.ts
// Records reputation feedback for an agent on Arc's ERC-8004 ReputationRegistry.
// Per ERC-8004: agent owners CANNOT record reputation for their own agents.
// The validator wallet must be different from the owner wallet.

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { withApiKeyOrAnySession } from '@/lib/middleware/withMerchantAuth';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { keccak256, toHex } from 'viem';

// ── Authoritative validator wallet resolution ─────────────────────────────
// Resolves the Circle wallet ID that AUTHORITATIVELY corresponds to
// validatorSCA by querying DB tables the platform controls. Never trusts
// a client-supplied walletId — it is only compared against this value.
// Mirrors src/lib/trust/autoReputation.ts resolution order.
async function resolveAuthoritativeValidatorWalletId(validatorSCA: string): Promise<string | null> {
  // 1. AgentRegistry (validator is an agent SCA)
  try {
    const agent: any = await (prisma as any).agentRegistry.findFirst({
      where: { scaAddress: { equals: validatorSCA, mode: 'insensitive' } },
      select: { circleWalletId: true },
    });
    if (agent?.circleWalletId) return agent.circleWalletId;
  } catch {}

  // 2. Merchant walletAddress
  try {
    const merchant: any = await (prisma as any).merchant.findFirst({
      where: { walletAddress: { equals: validatorSCA, mode: 'insensitive' } },
      select: { circleWalletId: true },
    });
    if (merchant?.circleWalletId) return merchant.circleWalletId;
  } catch {}

  // 3. ConsumerAccount walletAddress
  try {
    const consumer: any = await (prisma as any).consumerAccount.findFirst({
      where: { walletAddress: { equals: validatorSCA, mode: 'insensitive' } },
      select: { circleWalletId: true },
    });
    if (consumer?.circleWalletId) return consumer.circleWalletId;
  } catch {}

  // 4. CircleWallet table (address -> walletId)
  try {
    const cw: any = await (prisma as any).circleWallet.findFirst({
      where: { address: { equals: validatorSCA, mode: 'insensitive' } },
      select: { walletId: true },
    });
    if (cw?.walletId) return cw.walletId;
  } catch {}

  // 5. Env validator fallback (platform validator, same as autoReputation)
  const envAddr = (process.env.AGENT_VALIDATOR_WALLET_ADDRESS || '').toLowerCase();
  const envId = process.env.AGENT_VALIDATOR_WALLET_ID || null;
  if (envAddr && envId && validatorSCA.toLowerCase() === envAddr) return envId;

  return null;
}

// ── ERC-8004 contracts on Arc Testnet ─────────────────────────────────────────
const REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

async function waitForTx(
  client: ReturnType<typeof getCircleClient>,
  txId: string
): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const { data } = await client.getTransaction({ id: txId });
    if (data?.transaction?.state === 'COMPLETE' && data.transaction.txHash) {
      return data.transaction.txHash;
    }
    if (data?.transaction?.state === 'FAILED') {
      throw new Error('Transaction failed onchain.');
    }
  }
  throw new Error('Transaction timed out.');
}

// ─── POST /api/agent/reputation ───────────────────────────────────────────────
// Records reputation feedback from a validator for an agent.
// Body: { agentId, validatorSCA, score (0-100), tag, validatorWalletId? }
// validatorWalletId is OPTIONAL — if supplied it MUST match the authoritative
// walletId resolved server-side for validatorSCA (see resolveAuthoritative...).
// If omitted the server derives it. Client-supplied walletId is never trusted
// as the signing identity — the authoritative value is always used.
async function reputationHandler(request: NextRequest) {
  try {
    const {
      agentId, // ERC-8004 tokenId e.g. "68210"
      validatorSCA, // Validator wallet address (NOT the agent owner)
      validatorWalletId: clientValidatorWalletId, // Circle wallet ID — OPTIONAL, verified if present
      score, // 0-100 reputation score
      tag, // e.g. "successful_payment", "completed_job"
      feedbackType, // 0 = positive, 1 = negative, 2 = neutral
    } = await request.json();

    if (!agentId || !validatorSCA || score === undefined || !tag) {
      return NextResponse.json(
        {
          success: false,
          error: 'agentId, validatorSCA, score and tag are required.',
        },
        { status: 400 }
      );
    }

    if (score < 0 || score > 100) {
      return NextResponse.json(
        { success: false, error: 'Score must be between 0 and 100.' },
        { status: 400 }
      );
    }

    // Verify agent exists in registry
    const agent = await (prisma as any).agentRegistry.findFirst({
      where: { tokenId: agentId.toString() },
    });

    if (!agent) {
      return NextResponse.json(
        { success: false, error: `Agent with tokenId ${agentId} not found in registry.` },
        { status: 404 }
      );
    }

    // Ensure validator is not the agent owner
    if (validatorSCA.toLowerCase() === agent.scaAddress.toLowerCase()) {
      return NextResponse.json(
        {
          success: false,
          error: 'Per ERC-8004, agent owners cannot record reputation for their own agents.',
        },
        { status: 400 }
      );
    }

    // Ownership check — no fixed party list to check membership against
    // (any third party can validate per ERC-8004), but the caller must
    // actually control the address they're posting feedback as.
    const actor = await verifyCallerControlsAddress(request, validatorSCA);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'You do not control the wallet named in validatorSCA.' },
        { status: 403 }
      );
    }

    // ── Authoritative validator wallet binding ──────────────────────────
    // Never trust a client-supplied walletId as the signing identity.
    // Resolve the walletId that AUTHORITATIVELY belongs to validatorSCA
    // via DB/env, and if the client supplied one, require an exact match.
    const authoritativeWalletId = await resolveAuthoritativeValidatorWalletId(validatorSCA);
    if (!authoritativeWalletId) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Validator wallet not resolvable for validatorSCA — no Circle wallet found for that address. Use a wallet managed by this platform (merchant, agent, or consumer) or configure the platform validator env.',
        },
        { status: 400 }
      );
    }
    if (clientValidatorWalletId && String(clientValidatorWalletId) !== String(authoritativeWalletId)) {
      return NextResponse.json(
        {
          success: false,
          error: 'validatorWalletId does not match the authoritative wallet for validatorSCA.',
        },
        { status: 400 }
      );
    }
    // Optional on-chain binding check: the Circle wallet's on-chain address
    // must equal validatorSCA (defence-in-depth against stale DB rows).
    // Best-effort: if Circle lookup fails, fall through — DB binding already enforced.
    try {
      const circleClientForCheck = getCircleClient();
      const w = await circleClientForCheck.getWallet({ id: authoritativeWalletId });
      const onChainAddress = (w as any)?.data?.wallet?.address as string | undefined;
      if (onChainAddress && onChainAddress.toLowerCase() !== validatorSCA.toLowerCase()) {
        return NextResponse.json(
          {
            success: false,
            error: 'Validator wallet binding mismatch — Circle wallet address does not equal validatorSCA.',
          },
          { status: 400 }
        );
      }
    } catch {
      // Circle lookup flake is not a user error — proceed with DB binding
    }

    const circleClient = getCircleClient();
    const feedbackHash = keccak256(toHex(tag)) as `0x${string}`;

    // Call giveFeedback on ReputationRegistry
    const reputationTx = await circleClient.createContractExecutionTransaction({
      walletAddress: validatorSCA,
      blockchain: 'ARC-TESTNET' as any,
      contractAddress: REPUTATION_REGISTRY,
      abiFunctionSignature:
        'giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)',
      abiParameters: [
        agentId.toString(),
        score.toString(),
        (feedbackType || 0).toString(),
        tag,
        '', // metadataURI — optional
        '', // evidenceURI — optional
        '', // comment — optional
        feedbackHash,
      ],
      fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    });

    if (!reputationTx.data?.id) {
      throw new Error('Circle transaction returned no ID.');
    }

    const txHash = await waitForTx(circleClient, reputationTx.data.id);

    console.log(`✅ Reputation recorded for agent ${agentId}. Score: ${score}. Tx: ${txHash}`);

    return NextResponse.json({
      success: true,
      agentId,
      agentName: agent.name,
      score,
      tag,
      feedbackHash,
      validatorSCA,
      txHash,
      explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
      message: `Reputation score ${score}/100 recorded for agent #${agentId} — tag: ${tag}`,
    });
  } catch (error: any) {
    console.error('❌ Reputation error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKeyOrAnySession(reputationHandler as any);

// ─── GET /api/agent/reputation?agentId=xxx ────────────────────────────────────
// Returns reputation events for an agent from Postgres job history
async function getReputationHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const agentId = searchParams.get('agentId');
    const scaAddress = searchParams.get('scaAddress');

    if (!agentId && !scaAddress) {
      return NextResponse.json(
        { success: false, error: 'Pass agentId or scaAddress as query param.' },
        { status: 400 }
      );
    }

    const where: any = {};
    if (agentId) where.tokenId = agentId;
    if (scaAddress) where.scaAddress = scaAddress;

    const agent = await (prisma as any).agentRegistry.findFirst({ where });

    if (!agent) {
      return NextResponse.json({ success: false, error: 'Agent not found.' }, { status: 404 });
    }

    // Pull payment history as proxy for reputation activity
    const payments = await prisma.paymentLog.findMany({
      where: { senderEmail: agent.scaAddress },
      orderBy: { timestamp: 'desc' },
    });

    const successCount = payments.filter((p) => p.status === 'SUCCESS').length;
    const totalVolume = payments
      .filter((p) => p.status === 'SUCCESS')
      .reduce((sum, p) => sum + p.amount, 0);

    const estimatedScore =
      payments.length === 0 ? 0 : Math.round((successCount / payments.length) * 100);

    return NextResponse.json({
      success: true,
      agent: {
        tokenId: agent.tokenId,
        name: agent.name,
        scaAddress: agent.scaAddress,
        status: agent.status,
      },
      reputationSummary: {
        estimatedScore,
        totalPayments: payments.length,
        successfulPayments: successCount,
        totalVolumeUSDC: parseFloat(totalVolume.toFixed(6)),
        reputationRegistryAddress: REPUTATION_REGISTRY,
      },
      recentPayments: payments.slice(0, 10),
      message: `Agent #${agent.tokenId} reputation summary. For onchain reputation, check ArcScan.`,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKeyOrAnySession(getReputationHandler as any);
