// src/lib/gateway-middleware.ts
import { NextRequest, NextResponse } from "next/server";

const ARC_TESTNET_CHAIN = "eip155:5042002";
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";
const FACILITATOR_URL = "https://gateway-api-testnet.circle.com/v1/x402";

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
    const rawHeader = req.headers.get("x-payment") || req.headers.get("payment-signature");
    let paymentPayload: any = null;

    if (rawHeader) {
      try {
        // 1. Decode base64
        const decoded = Buffer.from(rawHeader, "base64").toString("utf-8");
        // 2. Parse JSON
        paymentPayload = JSON.parse(decoded);
      } catch (err) {
        console.error("Failed to decode/parse payment header:", err);
        // Fallback: try parsing as JSON directly (if not base64)
        try {
          paymentPayload = JSON.parse(rawHeader);
        } catch {
          paymentPayload = rawHeader; // Keep as string (will fail later)
        }
      }
    }

    // No payment → return 402
    if (!paymentPayload) {
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

    // Verify signature
    try {
      console.log("🔄 Verifying payment signature...");
      const verifyRes = await fetch(`${FACILITATOR_URL}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentPayload: paymentPayload,
          paymentRequirements: {
            scheme: "exact",
            network: ARC_TESTNET_CHAIN,
            amount: priceToAtomicUnits(options.priceUSDC),
            asset: USDC_ARC_TESTNET,
            payTo: options.sellerAddress,
            maxTimeoutSeconds: 300,
            extra: { name: "USDC", version: "2" },
          },
        }),
      });

      const verifyData = await verifyRes.json();
      console.log("✅ Verification response:", verifyData);

      if (!verifyRes.ok || !verifyData.success) {
        console.error("❌ Invalid signature:", verifyData);
        return NextResponse.json(
          { error: "Invalid or expired payment signature.", details: verifyData },
          { status: 402 }
        );
      }

      // Settle (optional)
      let settleData = {};
      try {
        const settleRes = await fetch(`${FACILITATOR_URL}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paymentPayload: paymentPayload,
            paymentRequirements: {
              scheme: "exact",
              network: ARC_TESTNET_CHAIN,
              amount: priceToAtomicUnits(options.priceUSDC),
              asset: USDC_ARC_TESTNET,
              payTo: options.sellerAddress,
              maxTimeoutSeconds: 300,
              extra: { name: "USDC", version: "2" },
            },
          }),
        });
        settleData = await settleRes.json();
      } catch (settleError) {
        console.warn("⚠️ Settlement call failed (will be batched):", settleError);
      }

      const payment: GatewayPaymentContext = {
        payer: verifyData.payer || "unknown",
        amount: priceToAtomicUnits(options.priceUSDC),
        network: ARC_TESTNET_CHAIN,
        transaction: settleData.transaction,
      };

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