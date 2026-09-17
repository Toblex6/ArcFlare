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
import { explorerTxUrl } from '@/lib/config/network';
import { getBridgeSourceChain, sourceExplorerTxUrl, formatBridgeBaseUnits } from '@/lib/bridge/sourceChains';
import { verifyArcMint, type MintVerifyFailure } from '@/lib/bridge/externalVerify';

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

    const proof = await verifyArcMint({ destination: intent.destination, mintTxHash });
    if (!proof.ok) {
      return NextResponse.json(
        { success: false, code: 'MINT_NOT_VERIFIED', reason: proof.reason, error: mintFailureCopy(proof.reason) },
        { status: 422 }
      );
    }

    const updated = await (prisma as any).flowBridgeIntent.update({
      where: { id: intent.id },
      data: { status: 'COMPLETED', mintTxHash: proof.mintTxHash, actualAmount: proof.actualAmount.toString() },
    });
    const source = getBridgeSourceChain(updated.sourceChain);

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
