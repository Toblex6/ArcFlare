// src/lib/gateway-middleware.ts
// Circle Gateway Nanopayments — x402 middleware wrapper for ArcFlare endpoints
// FIXED: corrected payment requirements to match real x402 spec.
// Previous version used "domain"/"maxAmountRequired" — wrong field names.
// Real spec uses "extra" (EIP-712 domain of the USDC token itself, not your
// app) and "amount". Source: x402 spec + Circle's own x402 blog post.

import { NextRequest, NextResponse } from "next/server";

const ARC_TESTNET_CHAIN = "eip155:5042002";
const FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

// USDC on Arc Testnet — same address used everywhere else in ArcFlare
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";

export interface GatewayPaymentContext {
  payer: string;
  amount: string;
  network: string;
  transaction?: string;
}

interface RequirePaymentOptions {
  sellerAddress: string;
  priceUSDC: string;
}

export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  return async function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    // Circle/x402 clients send the signed payload as X-PAYMENT, not "payment-signature"
    const paymentHeader = req.headers.get("x-payment") || req.headers.get("payment-signature");

    // ── No payment provided — return 402 with CORRECT payment requirements ──
    if (!paymentHeader) {
      return NextResponse.json(
        {
          x402Version: 2,
          error: "Payment required",
          resource: {
            url: req.nextUrl.pathname,
            description: `ArcFlare paid resource: ${req.nextUrl.pathname}`,
            mimeType: "application/json",
          },
          accepts: [
            {
              scheme: "exact",
              network: ARC_TESTNET_CHAIN,
              amount: priceToAtomicUnits(options.priceUSDC),
              asset: USDC_ARC_TESTNET,
              payTo: options.sellerAddress,
              maxTimeoutSeconds: 300,
              // ✅ extra = EIP-712 domain of the USDC TOKEN CONTRACT, not your app.
              // This MUST match what the USDC contract itself expects when
              // verifying the EIP-3009 transferWithAuthorization signature.
              extra: {
                name: "USDC",
                version: "2",
              },
            },
          ],
        },
        { status: 402 }
      );
    }

    // ── Verify the payment signature with Circle's facilitator ──────────────
    try {
      const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPayload: paymentHeader,
          paymentRequirements: {
            scheme: "exact",
            network: ARC_TESTNET_CHAIN,
            amount: priceToAtomicUnits(options.priceUSDC),
            asset: USDC_ARC_TESTNET,
            payTo: options.sellerAddress,
            extra: { name: "USDC", version: "2" },
          },
        }),
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok || !verifyData.valid) {
        return NextResponse.json(
          { error: "Invalid or expired payment signature.", details: verifyData },
          { status: 402 }
        );
      }

      // ── Settle via Circle's facilitator ──────────────────────────────────
      const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPayload: paymentHeader,
          paymentRequirements: {
            scheme: "exact",
            network: ARC_TESTNET_CHAIN,
            amount: priceToAtomicUnits(options.priceUSDC),
            asset: USDC_ARC_TESTNET,
            payTo: options.sellerAddress,
            extra: { name: "USDC", version: "2" },
          },
        }),
      });

      const settleData = await settleRes.json();

      const paymentContext: GatewayPaymentContext = {
        payer: verifyData.payer,
        amount: priceToAtomicUnits(options.priceUSDC),
        network: ARC_TESTNET_CHAIN,
        transaction: settleData.transaction,
      };

      return await handler(req, paymentContext);
    } catch (error: any) {
      console.error("Gateway payment verification error:", error);
      return NextResponse.json(
        { error: "Payment verification failed.", message: error.message },
        { status: 500 }
      );
    }
  };
}

function priceToAtomicUnits(priceUSDC: string): string {
  return Math.round(parseFloat(priceUSDC) * 1_000_000).toString();
}