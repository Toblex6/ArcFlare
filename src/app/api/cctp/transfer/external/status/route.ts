// src/app/api/cctp/transfer/external/status/route.ts
//
// Authoritative status for an EXTERNAL bridge intent. The browser polls
// this after intent/verify/complete steps to render the bridge lifecycle.
// Completion is proven by the complete endpoint's on-chain mint proof —
// this route only reports recorded state, never chain-derived guesses.

import { NextRequest, NextResponse } from 'next/server';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { prisma } from '@/src/lib/prisma';
import { explorerTxUrl } from '@/lib/config/network';
import { getBridgeSourceChain, sourceExplorerTxUrl, formatBridgeBaseUnits } from '@/lib/bridge/sourceChains';

export async function GET(req: NextRequest) {
  try {
    const sessionAddress = await resolveConsumerSession(req);
    if (!sessionAddress) {
      return NextResponse.json({ success: false, error: 'Sign in required.' }, { status: 401 });
    }
    const reference = req.nextUrl.searchParams.get('reference');
    if (!reference) {
      return NextResponse.json({ success: false, error: 'reference query param is required.' }, { status: 400 });
    }
    const intent = await (prisma as any).flowBridgeIntent.findUnique({ where: { id: reference } });
    // Same response for unknown and foreign intents — no existence oracle.
    if (!intent || intent.sourceWallet.toLowerCase() !== sessionAddress.toLowerCase()) {
      return NextResponse.json({ success: false, error: 'No bridge found for that reference.' }, { status: 404 });
    }
    const source = getBridgeSourceChain(intent.sourceChain);
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
      sourceLabel: source?.label ?? intent.sourceChain,
      destination: intent.destination,
      amount: intent.amount,
      amountDisplay: formatBridgeBaseUnits(BigInt(intent.amount)),
      actualAmount: intent.actualAmount,
      actualAmountDisplay: intent.actualAmount ? formatBridgeBaseUnits(BigInt(intent.actualAmount)) : null,
      destinationBound: intent.destinationBound,
      burnTxHash: intent.burnTxHash,
      mintTxHash: intent.mintTxHash,
      sourceExplorerUrl:
        intent.burnTxHash && source ? sourceExplorerTxUrl(source.id, intent.burnTxHash) : null,
      destinationExplorerUrl: intent.mintTxHash ? explorerTxUrl(intent.mintTxHash) : null,
      error: intent.status === 'FAILED' ? intent.error : undefined,
      expiresAt: intent.expiresAt,
    });
  } catch (error: any) {
    console.error('[cctp/transfer/external/status]', error);
    return NextResponse.json({ success: false, error: 'Could not load bridge status.' }, { status: 500 });
  }
}
