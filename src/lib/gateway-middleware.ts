// src/lib/gateway-middleware.ts
// Custom x402 middleware using Circle's Gateway API directly.
// No external dependencies beyond `fetch`.

import { NextRequest, NextResponse } from "next/server";

const ARC_TESTNET_CHAIN = "eip155:5042002";
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

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

export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  return async function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    // 1. Look for the payment header (CLI sends 'x-payment' or 'payment-signature')
    const paymentHeader =
      req.headers.get("x-payment") || req.headers.get("payment-signature");

    // 2. If no payment, return 402 with payment requirements
    if (!paymentHeader) {
      const priceAtomic = priceToAtomicUnits(options.priceUSDC);
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
              amount: priceAtomic,
              asset: USDC_ARC_TESTNET,
              payTo: options.sellerAddress,
              maxTimeoutSeconds: 300,
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

    // 3. Verify the signature with Circle's Gateway
    try {
      console.log("🔄 Verifying payment signature...");
      const verifyRes = await fetch(`${FACILITATOR_URL}/v1/payment/verify`, {
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
      console.log("✅ Verification response:", verifyData);

      if (!verifyRes.ok || !verifyData.valid) {
        console.error("❌ Invalid signature:", verifyData);
        return NextResponse.json(
          { error: "Invalid or expired payment signature.", details: verifyData },
          { status: 402 }
        );
      }

      // 4. (Optional) settle the payment – Gateway will batch settle anyway
      // We can call /settle to queue it, but it's not required for immediate response.
      let settleData = {};
      try {
        const settleRes = await fetch(`${FACILITATOR_URL}/v1/payment/settle`, {
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
        settleData = await settleRes.json();
      } catch (settleError) {
        console.warn("⚠️ Settlement call failed (will be batched):", settleError);
      }

      // 5. Build the payment context
      const payment: GatewayPaymentContext = {
        payer: verifyData.payer || "unknown",
        amount: priceToAtomicUnits(options.priceUSDC),
        network: ARC_TESTNET_CHAIN,
        transaction: settleData.transaction,
      };

      // 6. Execute the actual handler
      return await handler(req, payment);
    } catch (error: any) {
      console.error("❌ Gateway error:", error);
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