// src/app/api/gateway/route.ts
// Seller-side Gateway operations — check revenue balance and withdraw
// earnings to your Payout Wallet. Use this to manage FlareHQ's seller
// revenue from any Gateway-protected endpoints.

import { NextResponse } from 'next/server';
import { withApiKey } from '@/lib/middleware/withApiKey';

const FACILITATOR_URL = 'https://gateway-api-testnet.circle.com';
const ARC_TESTNET_CHAIN = 'ARC-TESTNET';

// ── GET /api/gateway?sellerAddress=0x... ──────────────────────────────────────
// Check the Seller Wallet's Gateway Balance (accrued revenue from paid calls)
async function getBalanceHandler(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sellerAddress = searchParams.get('sellerAddress') || process.env.SELLER_WALLET_ADDRESS;

    if (!sellerAddress) {
      return NextResponse.json(
        { success: false, error: 'sellerAddress is required.' },
        { status: 400 }
      );
    }

    const res = await fetch(
      `${FACILITATOR_URL}/balance?address=${sellerAddress}&chain=${ARC_TESTNET_CHAIN}`,
      { headers: { 'Content-Type': 'application/json' } }
    );

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Failed to fetch Gateway balance.');
    }

    return NextResponse.json({
      success: true,
      sellerAddress,
      gatewayBalance: data.balance,
      currency: 'USDC',
      chain: ARC_TESTNET_CHAIN,
      message: `Seller Gateway balance: ${data.balance} USDC accrued from paid API calls.`,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(getBalanceHandler);

// ── POST /api/gateway — withdraw Gateway revenue to Payout Wallet ─────────────
async function withdrawHandler(request: Request) {
  try {
    const { sellerAddress, payoutAddress, amount } = await request.json();

    const resolvedSeller = sellerAddress || process.env.SELLER_WALLET_ADDRESS;
    const resolvedPayout = payoutAddress || process.env.PAYOUT_WALLET_ADDRESS;

    if (!resolvedSeller || !resolvedPayout || !amount) {
      return NextResponse.json(
        {
          success: false,
          error:
            'sellerAddress, payoutAddress and amount are required (or set SELLER_WALLET_ADDRESS / PAYOUT_WALLET_ADDRESS env vars).',
        },
        { status: 400 }
      );
    }

    const res = await fetch(`${FACILITATOR_URL}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: resolvedSeller,
        chain: ARC_TESTNET_CHAIN,
        recipient: resolvedPayout,
        amount: amount.toString(),
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || 'Withdrawal failed.');
    }

    console.log(`✅ Withdrew ${amount} USDC from Gateway to ${resolvedPayout}`);

    return NextResponse.json({
      success: true,
      sellerAddress: resolvedSeller,
      payoutAddress: resolvedPayout,
      amount,
      txHash: data.transaction,
      explorerUrl: data.transaction
        ? `https://testnet.arcscan.app/tx/${data.transaction}`
        : undefined,
      message: `Withdrew ${amount} USDC from Gateway balance to Payout Wallet on Arc Testnet.`,
    });
  } catch (error: any) {
    console.error('❌ Gateway withdraw error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(withdrawHandler);
