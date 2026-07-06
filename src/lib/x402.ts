/**
 * src/lib/x402.ts
 * FINAL version with exhaustive logging for settlement debugging.
 * maxTimeoutSeconds increased to 6307200 (73 days) to fix
 * "authorization_validity_too_short" error.
 */

import { NextRequest, NextResponse } from "next/server";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { prisma } from "@/lib/prisma";

export const sellerAddress = process.env.SELLER_WALLET_ADDRESS as `0x${string}`;

const facilitator = new BatchFacilitatorClient();

function buildPaymentRequirements(price: string) {
  const amount = Math.round(parseFloat(price.replace("$", "")) * 1_000_000);
  return {
    scheme: "exact" as const,
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    amount: amount.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: 6307200,   // ✅ 73 days – accommodates buyer's validity
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    },
  };
}

function sanitizeBigInts(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeBigInts);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitizeBigInts(v)]));
  }
  return obj;
}

interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  const requirements = buildPaymentRequirements(price);

  return async (req: NextRequest) => {
    const paymentSignature = req.headers.get("payment-signature");

    if (!paymentSignature) {
      console.log(`[x402] 402 Payment Required: ${endpoint}`);
      const paymentRequired = {
        x402Version: 2,
        resource: {
          url: endpoint,
          description: `Paid resource (${price} USDC)`,
          mimeType: "application/json",
        },
        accepts: [requirements],
      };

      return new NextResponse(JSON.stringify({}), {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(
            JSON.stringify(sanitizeBigInts(paymentRequired))
          ).toString("base64"),
        },
      });
    }

    try {
      const decoded = Buffer.from(paymentSignature, "base64").toString("utf-8");
      console.log(`[x402] Decoded payment signature: ${decoded}`);
      const paymentPayload: PaymentPayload = JSON.parse(decoded);
      console.log(`[x402] Parsed paymentPayload: ${JSON.stringify(paymentPayload)}`);

      // Verify
      console.log(`[x402] Requirements: ${JSON.stringify(requirements)}`);
      const verifyResult = await facilitator.verify(paymentPayload, requirements);
      console.log(`[x402] Verify result: isValid=${verifyResult.isValid}, reason=${verifyResult.invalidReason}`);

      if (!verifyResult.isValid) {
        console.error(`[x402] Verification failed: ${verifyResult.invalidReason}`);
        return NextResponse.json(
          { error: "Payment verification failed", reason: verifyResult.invalidReason },
          { status: 402 }
        );
      }

      // Settle
      console.log(`[x402] Attempting settlement...`);
      const settleResult = await facilitator.settle(paymentPayload, requirements);
      console.log(`[x402] Full settleResult: ${JSON.stringify(settleResult)}`);

      if (!settleResult.success) {
        console.error(`[x402] Settlement failed: ${settleResult.errorReason}`);
        return NextResponse.json(
          { error: "Payment settlement failed", reason: settleResult.errorReason },
          { status: 402 }
        );
      }

      const amountUsdc = (Number(requirements.amount) / 1e6).toString();
      const payer = settleResult.payer ?? verifyResult.payer ?? "unknown";

      // Log to PaymentLog (non‑blocking)
      try {
        await prisma.paymentLog.create({
          data: {
            reference: `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            amount: parseFloat(amountUsdc),
            currency: "USDC",
            chain: "Arc Testnet (x402 Gateway Nanopayment)",
            senderEmail: payer,
            merchant: endpoint,
            status: "SUCCESS",
            arcTxHash: settleResult.transaction ?? null,
          },
        });
      } catch (logErr) {
        console.error("Failed to log x402 payment:", logErr);
      }

      console.log(`[x402] Settled: ${endpoint} — ${amountUsdc} USDC from ${payer}`);

      const response = await handler(req);

      const settleResponseHeader = Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settleResult.transaction,
          network: requirements.network,
          payer,
        })
      ).toString("base64");

      response.headers.set("PAYMENT-RESPONSE", settleResponseHeader);
      return response;
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[x402] Payment processing error:", message);
      console.error("[x402] Full error object:", error);
      if (error.cause) console.error("[x402] Cause:", error.cause);
      return NextResponse.json(
        { error: "Payment processing error", message },
        { status: 500 }
      );
    }
  };
}