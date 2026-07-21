// src/lib/gateway-middleware.ts
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
  priceUSDC: string;
}

export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  return async function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    // 1. Read and decode the x-payment header (base64-encoded JSON)
    const rawHeader = req.headers.get("x-payment") || req.headers.get("payment-signature");
    let paymentPayload: any = null;

    if (rawHeader) {
      try {
        const decoded = Buffer.from(rawHeader, "base64").toString("utf-8");
        paymentPayload = JSON.parse(decoded);
      } catch {
        try {
          paymentPayload = JSON.parse(rawHeader);
        } catch {
          paymentPayload = rawHeader;
        }
      }
    }

    // 2. No payment → return 402 with payment requirements
    if (!paymentPayload) {
      const priceAtomic = priceToAtomicUnits(options.priceUSDC);
      return NextResponse.json(
        {
          x402Version: 2,
          error: "Payment required",
          resource: {
            url: req.nextUrl.pathname,
            description: `FlareHQ paid resource: ${req.nextUrl.pathname}`,
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
                chainId: 5042002,
                verifyingContract: USDC_ARC_TESTNET,
              },
            },
          ],
        },
        { status: 402 }
      );
    }

    // 3. Payment provided → call Circle's settle endpoint directly
    try {
      console.log("💳 Settling x402 payment via Circle Gateway...");

      const requestBody = {
        paymentPayload: paymentPayload,
        paymentRequirements: {
          scheme: "exact",
          network: ARC_TESTNET_CHAIN,
          amount: priceToAtomicUnits(options.priceUSDC),
          asset: USDC_ARC_TESTNET,
          payTo: options.sellerAddress,
          maxTimeoutSeconds: 300,
          extra: {
            name: "USDC",
            version: "2",
            chainId: 5042002,
            verifyingContract: USDC_ARC_TESTNET,
          },
        },
      };

      const settleRes = await fetch(`${FACILITATOR_URL}/v1/x402/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const settleData = await settleRes.json();

      if (!settleRes.ok || !settleData.success) {
        console.error("❌ Settlement failed:", settleData);
        return NextResponse.json(
          { error: "Payment settlement failed.", details: settleData },
          { status: 402 }
        );
      }

      const payment: GatewayPaymentContext = {
        payer: settleData.payer || "unknown",
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