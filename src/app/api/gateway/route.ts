// src/app/api/gateway/route.ts
// Seller-side Gateway operations — check revenue balance and withdraw
// earnings to your Payout Wallet. Use this to manage FlareHQ's seller
// revenue from any Gateway-protected endpoints.

import { NextResponse, type NextRequest } from 'next/server';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { getNetworkConfig } from '@/lib/config/network';
import { verifyCallerControlsAddress } from '@/lib/wallet/verifyCallerControlsAddress';
import { USDC_AMOUNT_RE, MAX_USDC_AMOUNT } from '@/lib/validation';
import { isAddress } from 'viem';

// Facilitator URL + Circle chain flow from the authoritative network config
// (was hardcoded testnet Gateway URL + 'ARC-TESTNET').
function facilitatorUrl(): string {
  return getNetworkConfig().gatewayUrl;
}
function arcChain(): string {
  return getNetworkConfig().circleBlockchain;
}

// C1 fix 4: the balance view previously leaked targeting info (which seller
// addresses exist + their accrued revenue) to ANY ApiKey holder. It is now
// scoped to a seller the authenticated caller actually controls, through the
// single ownership gate (verifyCallerControlsAddress). No env fallback — an
// explicit sellerAddress is required so the gate below always has a concrete
// identity to verify.
async function getBalanceHandler(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const sellerAddress = searchParams.get('sellerAddress');

    if (!sellerAddress) {
      return NextResponse.json(
        { success: false, error: 'sellerAddress is required.' },
        { status: 400 }
      );
    }

    // Ownership gate: the caller must control this seller.
    const actor = await verifyCallerControlsAddress(request, sellerAddress);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'You do not control the seller wallet named in sellerAddress.' },
        { status: 403 }
      );
    }

    const res = await fetch(
      `${facilitatorUrl()}/balance?address=${sellerAddress}&chain=${arcChain()}`,
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
      chain: arcChain(),
      message: `Seller Gateway balance: ${data.balance} USDC accrued from paid API calls.`,
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const GET = withApiKey(getBalanceHandler);

// C1 fixes 1-3 on the pooled-revenue drain:
//   1. verifyCallerControlsAddress on the resolved seller — an ApiKey that
//      does not control the seller gets 403 before any funds move.
//   2. No env fallback: an explicit sellerAddress is required, then verified
//      through the gate above.
//   3. payoutAddress is restricted to the server-side treasury allowlist
//      already used by x402/seller/balance/withdraw
//      (SELLER_GATEWAY_TREASURY_ADDRESSES); when the allowlist is unset the
//      only permitted recipient is the seller's own address.
async function withdrawHandler(request: NextRequest) {
  try {
    const { sellerAddress, payoutAddress, amount } = await request.json();

    if (!sellerAddress || !payoutAddress || !amount) {
      return NextResponse.json(
        {
          success: false,
          error: 'sellerAddress, payoutAddress and amount are required.',
        },
        { status: 400 }
      );
    }

    const resolvedSeller = String(sellerAddress);
    const resolvedPayout = String(payoutAddress);
    const amountStr = String(amount);

    // H12: amount must be a plain decimal within the shared 10M USDC cap.
    if (!USDC_AMOUNT_RE.test(amountStr) || parseFloat(amountStr) > MAX_USDC_AMOUNT) {
      return NextResponse.json(
        { success: false, error: 'amount must be a decimal number not exceeding the maximum USDC amount.' },
        { status: 400 }
      );
    }

    // H12: addresses must be valid 0x addresses — both seller and payout
    // must be valid 0x addresses before any gate or facilitator call.
    if (!isAddress(resolvedSeller) || !isAddress(resolvedPayout)) {
      return NextResponse.json(
        { success: false, error: 'sellerAddress and payoutAddress must be valid 0x addresses.' },
        { status: 400 }
      );
    }

    const actor = await verifyCallerControlsAddress(request, resolvedSeller);
    if (!actor) {
      return NextResponse.json(
        { success: false, error: 'You do not control the seller wallet named in sellerAddress.' },
        { status: 403 }
      );
    }

    const treasuryAllowlist = (process.env.SELLER_GATEWAY_TREASURY_ADDRESSES || '')
      .split(',')
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean);
    const payoutAllowed = treasuryAllowlist.length > 0
      ? treasuryAllowlist.includes(resolvedPayout.toLowerCase())
      : resolvedPayout.toLowerCase() === resolvedSeller.toLowerCase();
    if (!payoutAllowed) {
      return NextResponse.json(
        {
          success: false,
          error: treasuryAllowlist.length > 0
            ? 'payoutAddress is not on the SELLER_GATEWAY_TREASURY_ADDRESSES allowlist.'
            : "payoutAddress is not allowed — configure SELLER_GATEWAY_TREASURY_ADDRESSES, or pay out to the seller's own address.",
        },
        { status: 403 }
      );
    }

    const res = await fetch(`${facilitatorUrl()}/withdraw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: resolvedSeller,
        chain: arcChain(),
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
      // Same Batch Facilitator as x402.ts's settle() — "transaction" here is
      // the Gateway's settlement reference, not confirmed to be a real onchain
      // hash. Shown honestly rather than assumed to be ArcScan-resolvable.
      gatewayReference: data.transaction ?? null,
      message: `Withdrew ${amount} USDC from Gateway balance to Payout Wallet on ${getNetworkConfig().name === 'mainnet' ? 'Arc' : 'Arc Testnet'}.`,
    });
  } catch (error: any) {
    console.error('❌ Gateway withdraw error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(withdrawHandler);
