// src/app/api/cctp/transfer/external/complete/route.ts
//
// Proves the Arc destination mint for a BURN_CONFIRMED external bridge
// intent. The browser submits the mint tx hash from its BridgeKit result;
// the server verifies the mined Arc receipt (canonical USDC credited the
// server-resolved destination) before recording COMPLETED with the measured
// actual. Only COMPLETED intents surface in Recent Activity.

import { NextRequest, NextResponse } from 'next/server';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { prisma } from '@/src/lib/prisma';
import { resolveConsumerWallet } from '@/src/lib/auth/consumerWallet';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { explorerTxUrl, getNetworkConfig } from '@/lib/config/network';
import { getBridgeSourceChain, sourceExplorerTxUrl, formatBridgeBaseUnits } from '@/lib/bridge/sourceChains';
import { verifyArcMint, type MintVerifyFailure } from '@/lib/bridge/externalVerify';
import { logBridgeStage } from '@/lib/bridge/stageLogger';

function mintFailureCopy(reason: MintVerifyFailure): string {
  switch (reason) {
    case 'NOT_FOUND':
      return 'Destination transaction not found on Arc yet. Wait a moment and try again.';
    case 'REVERTED':
      return 'The destination transaction reverted on-chain. The bridge was not completed.';
    case 'NO_DESTINATION_CREDIT':
      return 'That transaction did not credit your FlareHQ wallet. Bridge could not be completed.';
    case 'RPC_UNAVAILABLE':
      return 'Could not reach Arc. Your wallet was not charged unless a transaction was confirmed — try again.';
  }
}

export async function POST(req: NextRequest) {
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
    const { reference, mintTxHash } = body ?? {};
    if (typeof reference !== 'string' || !reference) {
      return NextResponse.json({ success: false, error: 'Missing reference.' }, { status: 400 });
    }
    if (typeof mintTxHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(mintTxHash)) {
      return NextResponse.json({ success: false, error: 'Missing or invalid destination transaction hash.' }, { status: 400 });
    }

    const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: reference } });
    if (!intent || intent.sourceWallet.toLowerCase() !== sessionAddress.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'No bridge found for that reference.' }, { status: 404 });
    }
    if (intent.status === 'COMPLETED') {
      return NextResponse.json({
        success: true,
        state: 'completed',
        reference: intent.id,
        actualAmount: intent.actualAmount,
        actualAmountDisplay: intent.actualAmount ? formatBridgeBaseUnits(BigInt(intent.actualAmount)) : null,
        destinationExplorerUrl: intent.mintTxHash ? explorerTxUrl(intent.mintTxHash) : null,
      });
    }
    if (intent.status === 'FAILED') {
      return NextResponse.json(
        { success: false, code: 'INTENT_FAILED', error: intent.error ?? 'This bridge failed and cannot be resumed.' },
        { status: 400 }
      );
    }
    if (intent.status !== 'BURN_CONFIRMED') {
      return NextResponse.json(
        { success: false, code: 'COMPLETE_REQUIRES_BURN', error: 'The source burn must be verified before completion.' },
        { status: 400 }
      );
    }
    if ((intent.mintTxHash ?? '').toLowerCase() === mintTxHash.toLowerCase() && intent.mintTxHash) {
      // Re-submit of an already-bound mint hash is a no-op, not an error.
      // (Binding happens only on verified success below.)
    }

    // Stage logs are awaited (not fire-and-forget): on serverless the
    // function may freeze before an un-awaited log flushes, leaving a
    // "MINT_PENDING with no outcome" silent stall. logBridgeStage never
    // throws, so awaiting is safe.
    await logBridgeStage(intent.id, {
      stage: 'MINT_PENDING',
      txHash: mintTxHash,
      chainId: getNetworkConfig().chainId,
      metadata: { destination: intent.destination },
    });
    const proof = await verifyArcMint({ destination: intent.destination, mintTxHash });
    if (!proof.ok) {
      await logBridgeStage(intent.id, {
        stage: 'FAILED',
        txHash: mintTxHash,
        chainId: getNetworkConfig().chainId,
        errorDetail: proof.detail ?? proof.reason,
        metadata: { reason: proof.reason },
      });
      return NextResponse.json(
        { success: false, code: 'MINT_NOT_VERIFIED', reason: proof.reason, error: mintFailureCopy(proof.reason) },
        { status: 422 }
      );
    }

    // H2: conditional claim — only BURN_CONFIRMED may advance to COMPLETED.
    // Concurrent complete calls race here; the loser re-reads and returns the
    // winner's state. P2002 (mintTxHash unique) maps to 409.
    let updated: any;
    try {
      const claim = await (prisma as any).flowBridgeIntent.updateMany({
        where: { id: intent.id, status: 'BURN_CONFIRMED' },
        data: { status: 'COMPLETED', mintTxHash: proof.mintTxHash, actualAmount: proof.actualAmount.toString() },
      });
      if (claim.count === 0) {
        const reread = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intent.id } });
        if (reread?.status === 'COMPLETED') {
          return NextResponse.json({
            success: true,
            state: 'completed',
            reference: reread.id,
            actualAmount: reread.actualAmount,
            actualAmountDisplay: reread.actualAmount ? formatBridgeBaseUnits(BigInt(reread.actualAmount)) : null,
            destinationExplorerUrl: reread.mintTxHash ? explorerTxUrl(reread.mintTxHash) : null,
          });
        }
        return NextResponse.json(
          { success: false, code: 'INTENT_STATE_CONFLICT', error: 'This bridge changed state while completing. Please retry.' },
          { status: 409 }
        );
      }
      updated = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: intent.id } });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return NextResponse.json(
          { success: false, code: 'INTENT_ALREADY_USED', error: 'This destination transaction is already bound to a bridge.' },
          { status: 409 }
        );
      }
      throw e;
    }
    const source = getBridgeSourceChain(updated.sourceChain);

    await logBridgeStage(intent.id, {
      stage: 'MINT_CONFIRMED',
      txHash: proof.mintTxHash,
      chainId: getNetworkConfig().chainId,
      metadata: { actualAmount: proof.actualAmount.toString() },
    });
    await logBridgeStage(intent.id, {
      stage: 'VERIFIED',
      txHash: proof.mintTxHash,
      chainId: getNetworkConfig().chainId,
    });

    return NextResponse.json({
      success: true,
      state: 'completed',
      reference: updated.id,
      amountDisplay: formatBridgeBaseUnits(BigInt(updated.amount)),
      actualAmount: updated.actualAmount,
      actualAmountDisplay: formatBridgeBaseUnits(proof.actualAmount),
      sourceChain: updated.sourceChain,
      sourceLabel: source?.label ?? updated.sourceChain,
      destination: updated.destination,
      sourceExplorerUrl: updated.burnTxHash && source ? sourceExplorerTxUrl(source.id, updated.burnTxHash) : null,
      destinationExplorerUrl: explorerTxUrl(proof.mintTxHash),
    });
  } catch (error: any) {
    console.error('[cctp/transfer/external/complete]', error);
    return NextResponse.json({ success: false, error: 'Could not complete the bridge. Please try again.' }, { status: 500 });
  }
}
