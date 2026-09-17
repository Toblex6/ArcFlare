// src/app/api/cctp/transfer/external/destination/route.ts
//
// Read-only, side-effect-free destination preview for the EXTERNAL Bridge
// UI: returns the server-resolved FlareHQ CIRCLE wallet that would receive
// a bridge (same resolver as the intent route). Lets the browser DISPLAY
// the destination without being authoritative for it.

import { NextRequest, NextResponse } from 'next/server';
import { resolveConsumerSession } from '@/src/lib/middleware/withConsumerAuth';
import { prisma } from '@/src/lib/prisma';
import { resolveConsumerWallet } from '@/src/lib/auth/consumerWallet';
import { resolveExternalBridgeDestination } from '@/lib/bridge/externalDestination';

export async function GET(req: NextRequest) {
  try {
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
        { success: false, code: 'WALLET_UNSUPPORTED', error: 'External wallets only.' },
        { status: 403 }
      );
    }
    const dest = await resolveExternalBridgeDestination(account);
    if (!dest.ok) {
      return NextResponse.json(
        { success: false, code: dest.code, reason: dest.reason, error: dest.error },
        { status: 400 }
      );
    }
    return NextResponse.json({ success: true, destination: dest.destination });
  } catch (error: any) {
    console.error('[cctp/transfer/external/destination]', error);
    return NextResponse.json({ success: false, error: 'Could not load destination.' }, { status: 500 });
  }
}
