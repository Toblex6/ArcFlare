// src/app/api/agents/[id]/treasury/credit/route.ts
// POST — fund an agent's treasury with real USDC.
//
// Why this exists: the procurement hire gate (evaluatePolicyForSpend) checks
// the hiring agent's LEDGER treasury (revenue - costs from AgentLedgerEntry),
// not just the on-chain wallet. A freshly provisioned agent has treasury 0, so
// hire fails with "insufficient available balance" even when the merchant has
// USDC. This endpoint closes that gap truthfully:
//
//   merchant Circle wallet -> real USDC -> agent Circle wallet
//   -> ADJUSTMENT CREDIT ledger entry (measured received delta)
//   -> treasury gate passes -> the later on-chain fund() also passes
//
// SECURITY: both wallets are derived SERVER-SIDE from authenticated identities.
// The request body carries ONLY { amountUSDC } — never a source/destination
// wallet id or address. Source = the authenticated merchant's own Circle wallet;
// destination = the agent's Circle wallet (must resolve to agent.scaAddress,
// fail-closed, same pattern as the accept/fund routes). The caller must control
// the agent (merchant owns it).
//
// The ledger entry uses type ADJUSTMENT (not REVENUE) deliberately — a treasury
// top-up is liquidity, not earned revenue, so it must never inflate the agent's
// trust/reputation signals.
//
// IDEMPOTENCY (P1-3, merchant/withdraw reference pattern): Idempotency-Key is
// MANDATORY. The PaymentLog row keyed by `treasury-credit:{agentId}:{key}`
// (unique) is claimed BEFORE the live transfer; a duplicate request with the
// same key replays the bound result and never creates another Circle
// transfer. The Circle transaction ID is persisted as soon as creation
// returns it, so crash-recovery resumes the tracked transfer instead of
// sending twice. The later ledger txHash dedupe stays as defense-in-depth —
// it was never sufficient alone (two transfers have two hashes).

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/src/lib/prisma';
import { withApiKeyOrAnySession, resolveMerchant } from '@/lib/middleware/withMerchantAuth';
import { resolveAgentRouteRefIdOnly as resolveAgentRouteRef } from '@/lib/agents/resolveAgentRef';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { getCircleClient } from '@/lib/circle/client';
import { recordLedgerEntry, usdcLedgerIdentity } from '@/lib/ledger/ledgerService';
import { computeTreasuryView } from '@/lib/ledger/treasuryService';
import {
  executeTrackedTransfer,
  prismaTrackedTransferStore,
  TransferInProgressError,
} from '@/src/lib/payments/trackedTransfer';
import { createPublicClient, http, erc20Abi } from 'viem';
import { getArcChain, getNetworkConfig } from '@/lib/config/network';
const arcTestnet = getArcChain();

const USDC_ARC: string = getNetworkConfig().usdcAddress;
const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

async function readUsdcBalance(owner: string): Promise<bigint> {
  const publicClient = createPublicClient({ chain: arcTestnet, transport: http(getNetworkConfig().primaryRpc) });
  return (await publicClient.readContract({
    address: USDC_ARC as `0x${string}`,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner as `0x${string}`],
  })) as bigint;
}

async function postHandler(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // M5: id-only on this caller-control endpoint (documented id-only policy).
  // Only strict registry ids resolve; tokenId/SCA aliases are a clean 404.
  const { agent: refAgent, ambiguous: refAmbiguous, malformed: refMalformed } = await resolveAgentRouteRef(id);
  if (refAmbiguous) {
    return NextResponse.json({ error: 'ambiguous agent reference' }, { status: 400 });
  }
  if (refMalformed) {
    return NextResponse.json({ error: 'invalid agent id' }, { status: 400 });
  }

  // P1-3: mandatory server idempotency key (merchant/withdraw pattern — the
  // key is required before any transfer can be initiated).
  const rawKey = req.headers.get('idempotency-key')?.trim();
  if (!rawKey || rawKey.length > 120) {
    return NextResponse.json(
      { success: false, error: 'Idempotency-Key header (1-120 chars) is required.' },
      { status: 400 }
    );
  }

  // Amount from the body — the ONLY thing the caller may supply.
  const body = await req.json().catch(() => ({}));
  const amountInput = body.amountUSDC;
  if (amountInput === undefined || amountInput === null || amountInput === '') {
    return NextResponse.json({ error: 'amountUSDC is required, e.g. { "amountUSDC": "5.00" }' }, { status: 400 });
  }
  const amountStr = String(amountInput).trim();
  if (!AMOUNT_RE.test(amountStr) || Number(amountStr) <= 0) {
    return NextResponse.json({ error: 'invalid amountUSDC — use a positive number with up to 6 decimals' }, { status: 400 });
  }

  // Auth: the caller must be a merchant who owns this agent.
  const merchant = await resolveMerchant(req).catch(() => null);
  if (!merchant?.id) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  const merchantRecord = await (prisma as any).merchant.findUnique({ where: { id: merchant.id } });
  if (!merchantRecord) {
    return NextResponse.json({ error: 'Merchant not found.' }, { status: 401 });
  }

  const agent = refAgent;
  if (!agent) return NextResponse.json({ error: 'agent not found' }, { status: 404 });
  const agentId: number = agent.id;
  const idempotencyKey = `treasury-credit:${agentId}:${rawKey}`;
  const actor = await verifyCallerControlsAddress(req, agent.scaAddress ?? '');
  if (!actor) return NextResponse.json({ error: 'You do not control this agent.' }, { status: 403 });

  // Source wallet — the merchant's own Circle wallet. Never caller-supplied.
  if (merchantRecord.walletProvider !== 'CIRCLE' || !merchantRecord.circleWalletId || !merchantRecord.walletAddress) {
    return NextResponse.json(
      { error: 'Treasury funding requires the merchant to hold a Circle wallet (this merchant does not).' },
      { status: 400 }
    );
  }
  const sourceWalletId: string = merchantRecord.circleWalletId;
  const sourceAddress: string = merchantRecord.walletAddress;

  // Destination wallet — the agent's Circle wallet, must resolve to scaAddress.
  if (!agent.circleWalletId || !agent.scaAddress) {
    return NextResponse.json({ error: 'agent has no Circle wallet to receive funds' }, { status: 400 });
  }
  const circleClient = getCircleClient();
  let destAddress: string;
  try {
    const w = await circleClient.getWallet({ id: agent.circleWalletId });
    destAddress = w.data?.wallet?.address as string;
    if (!destAddress) throw new Error('no address');
  } catch {
    return NextResponse.json({ error: 'agent Circle wallet not resolvable' }, { status: 400 });
  }
  if (destAddress.toLowerCase() !== agent.scaAddress.toLowerCase()) {
    return NextResponse.json({ error: 'agent Circle wallet does not match agent scaAddress' }, { status: 403 });
  }

  // Preflight: the merchant wallet must actually hold the USDC.
  let sourceBalance = 0n;
  try {
    sourceBalance = await readUsdcBalance(sourceAddress);
  } catch (e: any) {
    return NextResponse.json({ error: `could not read source USDC balance: ${e.message}` }, { status: 502 });
  }
  const amountWei = BigInt(Math.round(parseFloat(amountStr) * 1_000_000));
  if (sourceBalance < amountWei) {
    return NextResponse.json(
      { error: `Insufficient USDC in merchant wallet ${sourceAddress.slice(0, 10)}…: has ${(Number(sourceBalance) / 1e6).toFixed(4)}, needs ${amountStr}.` },
      { status: 400 }
    );
  }

  // Measure the destination's actual received delta (the Arc network applies a
  // per-transfer fee on top of the amount, so the ledger records what truly
  // arrived — never assume).
  let destBefore = 0n;
  try {
    destBefore = await readUsdcBalance(destAddress);
  } catch {}

  // P1-3: tenant guard on the idempotency scope (merchant/withdraw parity) —
  // a key bound to another merchant's credit replays as 409, never as funds.
  const boundClaim = await (prisma as any).paymentLog
    .findUnique({ where: { idempotencyKey } })
    .catch(() => null);
  if (boundClaim?.merchantId && boundClaim.merchantId !== merchant.id) {
    return NextResponse.json({ success: false, error: 'Idempotency key already in use.' }, { status: 409 });
  }

  // P1-3: idempotent live transfer. The claim row is created BEFORE the
  // on-chain write; the Circle transaction ID is persisted as soon as
  // creation returns it. Duplicate/replayed/crashed attempts resolve to the
  // SAME tracked transfer — a second Circle transfer is never created.
  const store = prismaTrackedTransferStore((prisma as any).paymentLog);
  let receivedWei = amountWei;
  let arcTxHash: string;
  let replayed = false;
  let resumed = false;
  try {
    const exec = await executeTrackedTransfer({
      store,
      circle: circleClient as any,
      idempotencyKey,
      claimData: {
        reference: `treasury-credit_${agentId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        amount: parseFloat(amountStr),
        currency: 'USDC',
        tokenAddress: USDC_ARC,
        chain: getNetworkConfig().circleBlockchain,
        senderEmail: merchantRecord.email ?? 'merchant@treasury-credit',
        merchant: merchantRecord.businessName ?? merchant.id,
        merchantId: merchant.id,
        merchantSCA: sourceAddress,
        agentSCA: destAddress,
        metadata: {
          requested: amountStr,
          sourceWalletId,
          purpose: 'treasury-fund',
          destBefore: destBefore.toString(),
        },
      },
      createNative: () =>
        (circleClient as any).createTransaction({
          walletId: sourceWalletId,
          blockchain: getNetworkConfig().circleBlockchain,
          tokenAddress: USDC_ARC,
          destinationAddress: destAddress,
          amounts: [amountStr],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        }),
      createFallback: () =>
        (circleClient as any).createContractExecutionTransaction({
          walletAddress: sourceAddress,
          blockchain: getNetworkConfig().circleBlockchain,
          contractAddress: USDC_ARC,
          abiFunctionSignature: 'transfer(address,uint256)',
          abiParameters: [destAddress, amountWei.toString()],
          fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
        }),
      // Idempotent completion (may run twice across crash-recovery):
      // re-measures the received delta from the claim's persisted destBefore
      // and records the ADJUSTMENT CREDIT exactly once via txHash dedupe.
      // NOTE: txHash comes from the executor — the claim row carries no
      // arcTxHash yet at this point (SUCCESS is marked after this runs).
      onConfirmed: async (confirmedTxHash: string) => {
        let base = destBefore;
        try {
          const claim = await (prisma as any).paymentLog
            .findUnique({ where: { idempotencyKey } })
            .catch(() => null);
          const persisted = (claim?.metadata as any)?.destBefore;
          if (typeof persisted === 'string' && /^[0-9]+$/.test(persisted)) base = BigInt(persisted);
        } catch {}
        let measured = amountWei;
        try {
          const destAfter = await readUsdcBalance(destAddress);
          const delta = destAfter - base;
          if (delta > 0n) measured = delta;
        } catch {
          // RPC hiccup — fall back to the nominal amount; the transfer itself
          // already succeeded, so failing here would leave money moved but no
          // ledger record. Record nominal and note it.
        }
        receivedWei = measured;
        // Ledger: ADJUSTMENT CREDIT deduped by txHash (idempotent retry-safe).
        // Phase 2D: treasury top-ups are explicitly USDC-only.
        await recordLedgerEntry({
          ...usdcLedgerIdentity(),
          agentRegistryId: agentId,
          type: 'ADJUSTMENT',
          amount: measured,
          direction: 'CREDIT',
          txHash: confirmedTxHash,
          description: `treasury fund top-up ${amountStr} USDC from merchant wallet`,
          metadata: { requested: amountStr, sourceWalletId, purpose: 'treasury-fund' },
        });
      },
    });
    arcTxHash = exec.txHash;
    replayed = exec.replayed;
    resumed = exec.resumed;
  } catch (e: any) {
    if (e instanceof TransferInProgressError || e?.name === 'TransferInProgressError') {
      return NextResponse.json(
        { success: false, error: 'This treasury credit is already being processed — retry with the same Idempotency-Key shortly.' },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: `transfer failed: ${e.message}` }, { status: 500 });
  }

  if (replayed) {
    // Reuse the bound result: the canonical received amount is the ledgered
    // one (SUCCESS implies onConfirmed completed, so the entry must exist).
    const dedupeKey = `${arcTxHash.toLowerCase()}:${agentId}:ADJUSTMENT`;
    const entry = await (prisma as any).agentLedgerEntry
      .findUnique({ where: { dedupeKey } })
      .catch(() => null);
    if (!entry) {
      return NextResponse.json(
        { success: false, error: 'completed treasury credit has no ledger record' },
        { status: 500 }
      );
    }
    receivedWei = BigInt(entry.amount);
  }

  const treasury = await computeTreasuryView(agentId);
  return NextResponse.json({
    success: true,
    agentId,
    requested: amountStr,
    receivedUsdc: (Number(receivedWei) / 1e6).toFixed(6),
    txHash: arcTxHash,
    treasury,
    replayed,
    resumed,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withApiKeyOrAnySession((inner: NextRequest) => postHandler(inner, ctx))(req);
}
