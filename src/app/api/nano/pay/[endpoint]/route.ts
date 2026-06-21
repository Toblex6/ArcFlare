// src/app/api/nano/pay/[endpoint]/route.ts
// Example of a real Gateway-Nanopayments-protected endpoint on ArcFlare.
// This REPLACES the old manual nano recording for any endpoint you want
// to charge per-call. Use this pattern for any paid resource — agent
// data lookups, premium API calls, per-inference billing, etc.
//
// This is a TEMPLATE — duplicate this file per paid resource, or adapt
// it into a generic catch-all route as shown.

import { NextRequest, NextResponse } from 'next/server';
import { requireGatewayPayment, GatewayPaymentContext } from '@/lib/gateway-middleware';

const SELLER_WALLET_ADDRESS = process.env.SELLER_WALLET_ADDRESS!;

// Price table per resource — extend as you add more paid endpoints
const PRICE_TABLE: Record<string, string> = {
  'agent-lookup': '0.001',
  'reputation-check': '0.0005',
  'job-status': '0.0001',
};

async function handlePaidResource(
  req: NextRequest,
  payment: GatewayPaymentContext,
  endpoint: string
): Promise<NextResponse> {
  // ── Your actual paid logic goes here ───────────────────────────────────────
  // Example: agent-lookup resource
  if (endpoint === 'agent-lookup') {
    const { searchParams } = new URL(req.url);
    const scaAddress = searchParams.get('scaAddress');

    return NextResponse.json({
      success: true,
      resource: 'agent-lookup',
      scaAddress,
      // ...fetch real agent data from your DB here
      paid: {
        amount: payment.amount,
        payer: payment.payer,
        network: payment.network,
        transaction: payment.transaction,
      },
    });
  }

  return NextResponse.json({
    success: true,
    resource: endpoint,
    paid: payment,
  });
}

// ── Dynamic route: /api/nano/pay/agent-lookup, /api/nano/pay/reputation-check, etc ──
export async function POST(req: NextRequest, { params }: { params: { endpoint: string } }) {
  const endpoint = params.endpoint;
  const priceUSDC = PRICE_TABLE[endpoint];

  if (!priceUSDC) {
    return NextResponse.json({ error: `Unknown paid resource: ${endpoint}` }, { status: 404 });
  }

  const wrapped = requireGatewayPayment(
    { sellerAddress: SELLER_WALLET_ADDRESS, priceUSDC },
    (req, payment) => handlePaidResource(req, payment, endpoint)
  );

  return wrapped(req);
}
