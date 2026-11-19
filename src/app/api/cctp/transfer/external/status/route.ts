// src/app/api/cctp/transfer/external/status/route.ts
//
// Authoritative status for an EXTERNAL bridge intent. The browser polls
// this after intent/verify/complete steps to render the bridge lifecycle.
// Completion is proven by the complete endpoint's on-chain mint proof —
// this route only reports recorded state, never chain-derived guesses.

import { NextRequest, NextResponse } from 'next/server';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { prisma } from '@/src/lib/prisma';
import { explorerTxUrl, getArcNetworkName } from '@/lib/config/network';
import { findBridgeSourceChain, sourceExplorerTxUrl, formatBridgeBaseUnits } from '@/lib/bridge/sourceChains';
import { getBridgeStageHistory, getBridgeCurrentStage } from '@/lib/bridge/stageLogger';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { sourceCctpV2 } from '@/lib/bridge/externalVerify';
import { fetchIrisBridgeMessage } from '@/lib/bridge/irisNonce';

export async function GET(req: NextRequest) {
  try {
    const sessionAddress = await resolveConsumerSession(req);
    if (!sessionAddress) {
      return NextResponse.json({ success: false, error: 'Sign in required.' }, { status: 401 });
    }
    const actor = await verifyCallerControlsAddress(req, sessionAddress);
    if (!actor) return NextResponse.json({ success: false, error: 'You do not control the source wallet.' }, { status: 403 });
    const reference = req.nextUrl.searchParams.get('reference');
    if (!reference) {
      return NextResponse.json({ success: false, error: 'reference query param is required.' }, { status: 400 });
    }
    const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: reference } });
    // Same response for unknown and foreign intents — no existence oracle.
    if (!intent || intent.sourceWallet.toLowerCase() !== sessionAddress.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'No bridge found for that reference.' }, { status: 404 });
    }
    const found = findBridgeSourceChain(intent.sourceChain);
    const source = found?.chain;

    // Read-only discovery breaks the reload deadlock: the mint hash is not
    // recorded until /complete proves it. Iris supplies a candidate, never
    // a completed state or an unverified database credit.
    let relayMintTxHash: string | null = null;
    let attestationState: string | null = null;
    const cctp = sourceCctpV2(intent.sourceChain);
    if (intent.status === 'BURN_CONFIRMED' && intent.burnTxHash && cctp && found?.network === getArcNetworkName()) {
      const iris = await fetchIrisBridgeMessage({ sourceDomain: cctp.domain, burnTxHash: intent.burnTxHash });
      attestationState = iris.ok ? 'complete' : iris.reason;
      if (iris.ok) relayMintTxHash = iris.destinationMintTxHash ?? iris.forwardTxHash;
    }

    // Stage history: the full append-only log + the current (latest) stage.
    const [stageHistory, currentStage] = await Promise.all([
      getBridgeStageHistory(intent.id),
      getBridgeCurrentStage(intent.id),
    ]);

    return NextResponse.json({
      success: true,
      reference: intent.id,
      state:
        intent.status === 'PENDING'
          ? 'pending'
          : intent.status === 'BURN_CONFIRMED'
            ? 'burn-confirmed'
            : intent.status === 'COMPLETED'
              ? 'completed'
              : 'failed',
      sourceChain: intent.sourceChain,
      sourceAddress: intent.sourceWallet,
      network: found?.network ?? null,
      sourceLabel: source?.label ?? intent.sourceChain,
      destination: intent.destination,
      amount: intent.amount,
      amountDisplay: formatBridgeBaseUnits(BigInt(intent.amount)),
      actualAmount: intent.actualAmount,
      actualAmountDisplay: intent.actualAmount ? formatBridgeBaseUnits(BigInt(intent.actualAmount)) : null,
      destinationBound: intent.destinationBound,
      burnTxHash: intent.burnTxHash,
      mintTxHash: intent.mintTxHash,
      relayMintTxHash,
      attestationState,
      sourceExplorerUrl:
        intent.burnTxHash && source ? sourceExplorerTxUrl(source.id, intent.burnTxHash, found!.network) : null,
      destinationExplorerUrl: intent.mintTxHash ? explorerTxUrl(intent.mintTxHash) : null,
      error: intent.status === 'FAILED' ? intent.error : undefined,
      expiresAt: intent.expiresAt,
      // Stage diagnostics: current stage + last txHash + full history.
      currentStage: currentStage?.stage ?? null,
      lastStageTxHash: currentStage?.txHash ?? null,
      stageHistory: stageHistory.map((s: any) => ({
        stage: s.stage,
        txHash: s.txHash,
        chainId: s.chainId,
        errorDetail: s.errorDetail,
        metadata: s.metadata ? JSON.parse(s.metadata) : null,
        createdAt: s.createdAt,
      })),
    });
  } catch (error: any) {
    console.error('[cctp/transfer/external/status]', error);
    return NextResponse.json({ success: false, error: 'Could not load bridge status.' }, { status: 500 });
  }
}
