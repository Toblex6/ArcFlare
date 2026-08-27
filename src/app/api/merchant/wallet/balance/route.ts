// src/app/api/merchant/wallet/balance/route.ts
// USDC balance lookup for a wallet the authenticated merchant controls.
//
// WHY: jobs/payroll/scheduled pages execute real transfers from the
// merchant's payer wallet, and every shortfall used to surface as a
// generic "Transaction failed onchain." after gas was spent. Showing the
// balance next to the action (and preflighting server-side) turns those
// into visible "Insufficient USDC" messages before anything is signed.
//
// Auth: merchant session (cookie or API key). The queried address must be
// one the caller controls — own wallet, buyer EOA, or owned agent SCAs —
// so this can't be used as an arbitrary address-probing oracle.

import { NextRequest, NextResponse } from 'next/server';
import { withMerchantAuth } from '@/lib/middleware/withMerchantAuth';
import { getCallerControlledAddresses } from '@/lib/wallet/verifyCallerControlsAddress';
import { getUsdcBalance } from '@/lib/wallet/usdcBalance';

async function balanceHandler(req: NextRequest, merchant: { id: string }) {
  try {
    const { searchParams } = new URL(req.url);
    const address = searchParams.get('address') || '';

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return NextResponse.json(
        { success: false, error: 'address query param must be a valid 0x address.' },
        { status: 400 }
      );
    }

    const controlled = await getCallerControlledAddresses(req);
    if (!controlled.has(address.toLowerCase())) {
      return NextResponse.json(
        { success: false, error: 'You do not control this wallet.' },
        { status: 403 }
      );
    }

    const balance = await getUsdcBalance(address);

    return NextResponse.json({
      success: true,
      address,
      balance,
      currency: 'USDC',
      chain: 'arc-testnet',
      merchantId: merchant.id,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withMerchantAuth(balanceHandler);
export const dynamic = 'force-dynamic';
