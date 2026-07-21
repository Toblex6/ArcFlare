// src/lib/gateway-middleware.ts
// Circle Gateway Nanopayments — x402 middleware wrapper for FlareHQ endpoints
// Replaces manual nano recording/batching with Circle's real Gateway product.
//
// Install first:
//   npm install viem
//
// This wraps any Next.js API route handler so it requires payment via
// the x402 protocol before running. Circle's hosted Arc Testnet facilitator
// verifies the signed payment and queues it for Gateway batch settlement.

import { NextRequest, NextResponse } from 'next/server';

// Arc Testnet chain identifier in eip155 format
const ARC_TESTNET_CHAIN = 'eip155:5042002';

// Circle's hosted testnet facilitator — verifies x402 payments and
// queues them for Gateway batch settlement. No infra to run yourself.
const FACILITATOR_URL = 'https://gateway-api-testnet.circle.com';

export interface GatewayPaymentContext {
  payer: string;
  amount: string;
  network: string;
  transaction?: string;
}

interface RequirePaymentOptions {
  sellerAddress: string;
  priceUSDC: string; // e.g. "0.001"
}

/**
 * Wraps a Next.js route handler so it requires an x402 USDC payment
 * before executing. Returns 402 Payment Required if no valid payment
 * authorization is present on the request.
 *
 * Usage in a route file:
 *
 *   export const POST = requireGatewayPayment(
 *     { sellerAddress: process.env.SELLER_WALLET_ADDRESS!, priceUSDC: "0.001" },
 *     async (req, payment) => {
 *       // payment.payer, payment.amount, payment.transaction available here
 *       return NextResponse.json({ data: "your paid response" });
 *     }
 *   );
 */
export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  return async function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    const paymentSignature = req.headers.get('payment-signature');

    // ── No payment provided — return 402 with payment requirements ──────────
    if (!paymentSignature) {
      return NextResponse.json(
        {
          error: 'Payment Required',
          accepts: [
            {
              scheme: 'GatewayWalletBatched',
              network: ARC_TESTNET_CHAIN,
              maxAmountRequired: priceToAtomicUnits(options.priceUSDC),
              resource: req.nextUrl.pathname,
              payTo: options.sellerAddress,
              asset: 'USDC',
              facilitator: FACILITATOR_URL,
            },
          ],
        },
        { status: 402 }
      );
    }

    // ── Verify the payment signature with Circle's facilitator ──────────────
    try {
      const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentSignature,
          sellerAddress: options.sellerAddress,
          network: ARC_TESTNET_CHAIN,
          maxAmountRequired: priceToAtomicUnits(options.priceUSDC),
          resource: req.nextUrl.pathname,
        }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok || !verifyData.valid) {
        return NextResponse.json(
          { error: 'Invalid or expired payment signature.', details: verifyData },
          { status: 402 }
        );
      }

      // ── Queue for Gateway batch settlement ─────────────────────────────────
      const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentSignature, sellerAddress: options.sellerAddress }),
      });

      const settleData = await settleRes.json();

      const paymentContext: GatewayPaymentContext = {
        payer: verifyData.payer,
        amount: priceToAtomicUnits(options.priceUSDC),
        network: ARC_TESTNET_CHAIN,
        transaction: settleData.transaction,
      };

      // ── Payment verified — run the actual handler ────────────────────────
      return await handler(req, paymentContext);
    } catch (error: any) {
      console.error('Gateway payment verification error:', error);
      return NextResponse.json(
        { error: 'Payment verification failed.', message: error.message },
        { status: 500 }
      );
    }
  };
}

function priceToAtomicUnits(priceUSDC: string): string {
  // USDC has 6 decimals
  return Math.round(parseFloat(priceUSDC) * 1_000_000).toString();
}
