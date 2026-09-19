// src/app/api/cctp/transfer/external/verify/route.ts
//
// Proves the source-chain burn for a PENDING external bridge intent.
// The browser submits the burn tx hash from its BridgeKit result; the
// server verifies the mined receipt (sender == session wallet, canonical
// USDC debit == intent amount, best-effort DepositForBurn binding) before
// advancing the intent to BURN_CONFIRMED. A client "success" boolean or an
// unverified hash is never accepted.

import { NextRequest, NextResponse } from 'next/server';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { prisma } from '@/src/lib/prisma';
import { resolveConsumerWallet } from '@/src/lib/auth/consumerWallet';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { getBridgeSourceChain, sourceExplorerTxUrl } from '@/lib/bridge/sourceChains';
import { resolveExternalBridgeDestination } from '@/lib/bridge/externalDestination';
import { verifyExternalBurn, type BurnVerifyFailure } from '@/lib/bridge/externalVerify';
import { logBridgeStage } from '@/lib/bridge/stageLogger';

function burnFailureCopy(reason: BurnVerifyFailure, sourceLabel: string): string {
  switch (reason) {
    case 'NOT_FOUND':
    case 'NOT_MINED':
      return `Bridge transaction not found on ${sourceLabel} yet. Wait a moment and try again.`;
    case 'REVERTED':
      return 'The source transaction reverted on-chain. Your USDC was not moved by it.';
    case 'WRONG_SENDER':
      return 'That transaction was not sent by the connected wallet. Reconnect your wallet to continue.';
    case 'AMOUNT_MISMATCH':
      return 'That transaction moved a different amount than this bridge. Bridge approval was cancelled — start over with the correct amount.';
    case 'BINDING_MISMATCH':
      return 'That transaction does not pay your FlareHQ wallet on Arc. Your wallet was not charged by this bridge unless a transaction was confirmed.';
    case 'RPC_UNAVAILABLE':
      return 'Could not reach the source chain. Your wallet was not charged unless a transaction was confirmed — try again.';
  }
}

// Terminal contradictions (this hash can never satisfy this intent).
function isTerminalFailure(reason: BurnVerifyFailure): boolean {
  return reason === 'REVERTED' || reason === 'WRONG_SENDER' || reason === 'AMOUNT_MISMATCH' || reason === 'BINDING_MISMATCH';
}

export async function POST(req: NextRequest) {
  // Diagnosis instrumentation: prove whether verify is ever HIT. Render keeps
  // stdout, so log the hit + outcome with the intent reference BEFORE any
  // early return can hide it. Reference + hash are public chain identifiers.
  let dbgReference: string | null = null;
  let dbgBurnTxHash: string | null = null;
  try {
    const { allowed, response: limitResponse } = await checkRateLimit(req, 'payments');
    if (!allowed) return limitResponse!;

    const sessionAddress = await resolveConsumerSession(req);
    if (!sessionAddress) {
      return NextResponse.json({ success: false, error: 'Sign in required.' }, { status: 401 });
    }
    const account = await (prisma as any).consumerAccount.findUnique({
      where: { walletAddress: sessionAddress },
    });
    const wallet = resolveConsumerWallet(account);
    if (!wallet || wallet.mode !== 'EXTERNAL') {
      return NextResponse.json(
        { success: false, code: 'WALLET_UNSUPPORTED', error: 'This wallet cannot use the external bridge.' },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { reference, burnTxHash } = body ?? {};
    dbgReference = typeof reference === 'string' ? reference : null;
    dbgBurnTxHash = typeof burnTxHash === 'string' ? burnTxHash : null;
    console.log('[cctp/transfer/external/verify] HIT', { reference: dbgReference, burnTxHash: dbgBurnTxHash });
    if (typeof reference !== 'string' || !reference) {
      return NextResponse.json({ success: false, error: 'Missing reference.' }, { status: 400 });
    }
    if (typeof burnTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(burnTxHash)) {
      return NextResponse.json({ success: false, error: 'Missing or invalid burn transaction hash.' }, { status: 400 });
    }

    const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: reference } });
    // Same response for unknown and foreign intents — no existence oracle.
    if (!intent || intent.sourceWallet.toLowerCase() !== sessionAddress.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'No bridge found for that reference.' }, { status: 404 });
    }
    if (intent.status === 'COMPLETED') {
      return NextResponse.json({ success: true, state: 'completed', reference: intent.id });
    }
    if (intent.status === 'FAILED') {
      return NextResponse.json(
        { success: false, code: 'INTENT_FAILED', error: intent.error ?? 'This bridge failed and cannot be resumed.' },
        { status: 400 }
      );
    }
    if (intent.status === 'BURN_CONFIRMED') {
      // Idempotent re-submit of the same hash; a DIFFERENT hash is never
      // accepted once a burn is bound (prevents double-record).
      if ((intent.burnTxHash ?? '').toLowerCase() === burnTxHash.toLowerCase()) {
        const source = getBridgeSourceChain(intent.sourceChain);
        return NextResponse.json({
          success: true,
          state: 'burn-confirmed',
          reference: intent.id,
          destinationBound: intent.destinationBound,
          sourceExplorerUrl: source ? sourceExplorerTxUrl(source.id, intent.burnTxHash) : null,
        });
      }
      return NextResponse.json(
        { success: false, code: 'INTENT_ALREADY_USED', error: 'This bridge already has a verified burn transaction.' },
        { status: 409 }
      );
    }

    const source = getBridgeSourceChain(intent.sourceChain);
    const sourceLabel = source?.label ?? intent.sourceChain;

    if (new Date(intent.expiresAt).getTime() < Date.now()) {
      await (prisma as any).flowBridgeIntent.update({
        where: { id: intent.id },
        data: { status: 'FAILED', error: 'Bridge intent expired before the burn was submitted.' },
      });
      logBridgeStage(intent.id, {
        stage: 'FAILED',
        chainId: source?.chainId,
        errorDetail: 'Bridge intent expired before the burn was submitted.',
        metadata: { burnTxHash, sourceChain: intent.sourceChain },
      });
      return NextResponse.json(
        { success: false, code: 'INTENT_EXPIRED', error: 'This bridge expired before the burn was submitted. Start a new bridge to try again.' },
        { status: 400 }
      );
    }

    // Destination is re-resolved at verify time: if the link changed since
    // the intent was issued, fail closed rather than crediting a stale row.
    const dest = await resolveExternalBridgeDestination(account);
    if (!dest.ok) {
      return NextResponse.json({ success: false, code: dest.code, error: dest.error }, { status: 400 });
    }
    if (dest.destination.toLowerCase() !== intent.destination.toLowerCase()) {
      return NextResponse.json(
        { success: false, code: 'CIRCLE_WALLET_UNBOUND', error: 'The linked FlareHQ wallet changed — start a new bridge.' },
        { status: 400 }
      );
    }

    logBridgeStage(intent.id, {
      stage: 'BURN_PENDING',
      txHash: burnTxHash,
      chainId: source?.chainId,
      metadata: { sourceChain: intent.sourceChain, sourceAddress: intent.sourceWallet },
    });
    const proof = await verifyExternalBurn({
      sourceId: intent.sourceChain,
      sourceAddress: intent.sourceWallet,
      amountBaseUnits: BigInt(intent.amount),
      destination: intent.destination,
      burnTxHash,
    });
    if (!proof.ok) {
      console.log('[cctp/transfer/external/verify] BURN_NOT_VERIFIED', {
        reference: intent.id,
        reason: proof.reason,
        detail: (proof.detail ?? proof.reason ?? '').toString().slice(0, 300),
      });
      if (isTerminalFailure(proof.reason)) {
        await (prisma as any).flowBridgeIntent.update({
          where: { id: intent.id },
          data: { status: 'FAILED', error: burnFailureCopy(proof.reason, sourceLabel) },
        });
      }
      logBridgeStage(intent.id, {
        stage: 'FAILED',
        txHash: burnTxHash,
        chainId: source?.chainId,
        errorDetail: proof.detail ?? proof.reason,
        metadata: { reason: proof.reason, terminal: isTerminalFailure(proof.reason) },
      });
      return NextResponse.json(
        {
          success: false,
          code: 'BURN_NOT_VERIFIED',
          reason: proof.reason,
          error: burnFailureCopy(proof.reason, sourceLabel),
        },
        { status: 422 }
      );
    }

    const updated = await (prisma as any).flowBridgeIntent.update({
      where: { id: intent.id },
      data: { status: 'BURN_CONFIRMED', burnTxHash: proof.burnTxHash, destinationBound: proof.destinationBound },
    });
    console.log('[cctp/transfer/external/verify] BURN_CONFIRMED', { reference: intent.id, burnTxHash: proof.burnTxHash });

    logBridgeStage(intent.id, {
      stage: 'BURN_CONFIRMED',
      txHash: proof.burnTxHash,
      chainId: source?.chainId,
      metadata: { destinationBound: proof.destinationBound },
    });

    return NextResponse.json({
      success: true,
      state: 'burn-confirmed',
      reference: updated.id,
      destinationBound: updated.destinationBound,
      sourceExplorerUrl: source ? sourceExplorerTxUrl(source.id, proof.burnTxHash) : null,
    });
  } catch (error: any) {
    console.error('[cctp/transfer/external/verify] ERROR', { reference: dbgReference, burnTxHash: dbgBurnTxHash }, error);
    return NextResponse.json({ success: false, error: 'Could not verify the bridge. Please try again.' }, { status: 500 });
  }
}
