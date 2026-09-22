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
import { EMPTY_MESSAGE_NONCE } from '@/lib/bridge/irisNonce';
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
        // Backfill the Circle-attested CCTP message nonce for burns verified
        // before attested-nonce binding existed (or while Iris was still
        // pending): re-prove the already-bound hash and record the nonce so
        // completion can bind the mint to it. A stored zero placeholder is
        // treated as unbound (V2 emits MessageSent with EMPTY_NONCE — it can
        // never satisfy a genuine mint). Best-effort — a re-proof failure
        // (e.g. source RPC flake) or a still-pending attestation never
        // regresses the already-recorded BURN_CONFIRMED state.
        const storedNonce = (intent.cctpNonce as string | null) ?? null;
        if (!storedNonce || storedNonce.toLowerCase() === EMPTY_MESSAGE_NONCE) {
          const backfill = await verifyExternalBurn({
            sourceId: intent.sourceChain,
            sourceAddress: intent.sourceWallet,
            amountBaseUnits: BigInt(intent.amount),
            destination: intent.destination,
            burnTxHash,
          }).catch(() => null);
          if (backfill?.ok) {
            await (prisma as any).flowBridgeIntent.updateMany({
              where: { id: intent.id, status: 'BURN_CONFIRMED' },
              data: { cctpNonce: backfill.cctpNonce, destinationBound: true },
            });
            intent.cctpNonce = backfill.cctpNonce;
            await logBridgeStage(intent.id, {
              stage: 'BURN_CONFIRMED',
              txHash: burnTxHash,
              chainId: source?.chainId,
              metadata: { destinationBound: true, cctpNonce: backfill.cctpNonce, backfill: true },
            });
          }
        }
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

    // Expiry is evaluated AFTER on-chain verification, not before: a burn
    // that proves on-chain (exact sender + exact amount) disproves the
    // "never submitted" rationale for expiry, so a late verify still
    // advances (marked lateRecovery) instead of stranding a funded intent
    // as FAILED. Only an UNPROVABLE burn on an expired intent fails closed
    // here. (A verify that starts before expiry but lands after it advances
    // normally — the claim below is conditional on PENDING either way.)
    const expired = new Date(intent.expiresAt).getTime() < Date.now();

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

    // Stage logs are awaited (not fire-and-forget): on serverless the
    // function may freeze before an un-awaited log flushes, which previously
    // produced "BURN_PENDING with no outcome" silent stalls. logBridgeStage
    // never throws, so awaiting is safe.
    await logBridgeStage(intent.id, {
      stage: 'BURN_PENDING',
      txHash: burnTxHash,
      chainId: source?.chainId,
      metadata: { sourceChain: intent.sourceChain, sourceAddress: intent.sourceWallet, lateRetry: expired },
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
      if (expired && (proof.reason === 'NOT_FOUND' || proof.reason === 'NOT_MINED')) {
        // Expired and no burn was ever submitted for this hash — the only
        // case that still fails as INTENT_EXPIRED.
        // H2: conditional claim — never overwrite a concurrently-completed intent.
        await (prisma as any).flowBridgeIntent.updateMany({
          where: { id: intent.id, status: 'PENDING' },
          data: { status: 'FAILED', error: 'Bridge intent expired before the burn was submitted.' },
        });
        await logBridgeStage(intent.id, {
          stage: 'FAILED',
          txHash: burnTxHash,
          chainId: source?.chainId,
          errorDetail: 'Bridge intent expired before the burn was submitted.',
          metadata: { burnTxHash, sourceChain: intent.sourceChain, reason: proof.reason },
        });
        return NextResponse.json(
          { success: false, code: 'INTENT_EXPIRED', error: 'This bridge expired before the burn was submitted. Start a new bridge to try again.' },
          { status: 400 }
        );
      }
      if (isTerminalFailure(proof.reason)) {
        // H2: conditional claim — never overwrite a concurrently-completed intent.
        await (prisma as any).flowBridgeIntent.updateMany({
          where: { id: intent.id, status: 'PENDING' },
          data: { status: 'FAILED', error: burnFailureCopy(proof.reason, sourceLabel) },
        });
      }
      await logBridgeStage(intent.id, {
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

    // H2: conditional claim — only PENDING may advance to BURN_CONFIRMED.
    // Concurrent verify calls race here; the loser re-reads and returns the
    // winner's state instead of overwriting it. P2002 (burnTxHash unique)
    // maps to 409 so a replayed hash never 500s.
    let updated: any;
    try {
      const claim = await (prisma as any).flowBridgeIntent.updateMany({
        where: { id: intent.id, status: 'PENDING' },
        data: { status: 'BURN_CONFIRMED', burnTxHash: proof.burnTxHash, destinationBound: proof.destinationBound, cctpNonce: proof.cctpNonce },
      });
      if (claim.count === 0) {
        const reread = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intent.id } });
        if (reread?.status === 'BURN_CONFIRMED') {
          if ((reread.burnTxHash ?? '').toLowerCase() === proof.burnTxHash.toLowerCase()) {
            return NextResponse.json({
              success: true,
              state: 'burn-confirmed',
              reference: reread.id,
              destinationBound: reread.destinationBound,
              sourceExplorerUrl: source ? sourceExplorerTxUrl(source.id, reread.burnTxHash) : null,
            });
          }
          return NextResponse.json(
            { success: false, code: 'INTENT_ALREADY_USED', error: 'This bridge already has a verified burn transaction.' },
            { status: 409 }
          );
        }
        if (reread?.status === 'COMPLETED') {
          return NextResponse.json({ success: true, state: 'completed', reference: reread.id });
        }
        return NextResponse.json(
          { success: false, code: 'INTENT_STATE_CONFLICT', error: 'This bridge changed state while verifying. Please retry.' },
          { status: 409 }
        );
      }
      updated = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intent.id } });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return NextResponse.json(
          { success: false, code: 'INTENT_ALREADY_USED', error: 'This burn transaction is already bound to a bridge.' },
          { status: 409 }
        );
      }
      throw e;
    }
    console.log('[cctp/transfer/external/verify] BURN_CONFIRMED', { reference: intent.id, burnTxHash: proof.burnTxHash, lateRecovery: expired });

    await logBridgeStage(intent.id, {
      stage: 'BURN_CONFIRMED',
      txHash: proof.burnTxHash,
      chainId: source?.chainId,
      metadata: { destinationBound: proof.destinationBound, cctpNonce: proof.cctpNonce, lateRecovery: expired },
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
