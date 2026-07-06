/**
 * src/lib/x402.ts
 *
 * FINAL corrected version — field values confirmed from the version-pinning
 * diagnosis: @circle-fin/x402-batching v2.x required for Arc Testnet
 * (v3 defaults to mainnet and rejects eip155:5042002).
 *
 * Critical confirmed corrections vs every prior version:
 *   network:           "eip155:5042002"  (CAIP-2, NOT "arcTestnet" — that's
 *                                         buyer-side GatewayClient only)
 *   maxTimeoutSeconds: 604800            (not 345600 — rejected on testnet)
 *   extra.name:        "GatewayWalletBatched"
 *   extra.version:     "1"
 *   verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9"
 *   USDC:              "0x3600000000000000000000000000000000000000"
 */

import { NextRequest, NextResponse } from "next/server";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { prisma } from "@/lib/prisma";

export const sellerAddress = process.env.SELLER_WALLET_ADDRESS as `0x${string}`;

const facilitator = new BatchFacilitatorClient();

// ── Confirmed payment requirements for Arc Testnet ────────────────────────────
function buildPaymentRequirements(price: string) {
  const amount = Math.round(parseFloat(price.replace("$", "")) * 1_000_000);

  return {
    scheme: "exact" as const,
    network: "eip155:5042002",           // ✅ CAIP-2 — correct for facilitator
    asset: "0x3600000000000000000000000000000000000000",
    amount: amount.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: 604800,            // ✅ 7 days — testnet requires this
    extra: {
      name: "GatewayWalletBatched",      // ✅ confirmed
      version: "1",                       // ✅ confirmed
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9", // ✅ confirmed
    },
  };
}

// Sanitize BigInt recursively — JSON.stringify can't serialize BigInt natively
function sanitizeBigInts(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeBigInts);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, sanitizeBigInts(v)])
    );
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

/**
 * Wraps a Next.js route handler with Circle Gateway x402 payment protection.
 * Matches the exact pattern from circlefin/arc-nanopayments with v2 SDK.
 */
export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  const requirements = buildPaymentRequirements(price);

  return async (req: NextRequest) => {
    // Log the incoming request for debugging
    console.log(`[x402] Request to ${endpoint} with method ${req.method}`);

    const paymentSignature = req.headers.get("payment-signature");

    // ── No payment — return 402 with base64-encoded requirements ─────────────
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

      // Log what we're sending back
      console.log(`[x402] 402 response: ${JSON.stringify(paymentRequired)}`);

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

    // ── Payment present — verify via BatchFacilitatorClient ──────────────────
    try {
      let paymentPayload: PaymentPayload;
      try {
        const decoded = Buffer.from(paymentSignature, "base64").toString("utf-8");
        console.log(`[x402] Decoded payment signature: ${decoded}`);
        paymentPayload = JSON.parse(decoded);
        console.log(`[x402] Parsed paymentPayload: ${JSON.stringify(paymentPayload)}`);
      } catch (err) {
        console.error(`[x402] Failed to parse payment signature:`, err);
        return NextResponse.json(
          { error: "Invalid payment signature format." },
          { status: 402 }
        );
      }

      // Validate required fields in paymentPayload
      const requiredPayloadFields = ["x402Version", "resource", "accepted", "payload"];
      for (const field of requiredPayloadFields) {
        if (!(field in paymentPayload)) {
          console.error(`[x402] Missing field in paymentPayload: ${field}`);
          return NextResponse.json(
            { error: `Missing field in paymentPayload: ${field}` },
            { status: 400 }
          );
        }
      }

      // Validate requirements fields
      const requiredReqFields = ["scheme", "network", "asset", "amount", "maxTimeoutSeconds"];
      for (const field of requiredReqFields) {
        if (!(field in requirements)) {
          console.error(`[x402] Missing field in requirements: ${field}`);
          return NextResponse.json(
            { error: `Missing field in requirements: ${field}` },
            { status: 500 }
          );
        }
      }

      console.log(`[x402] Verified requirements: ${JSON.stringify(requirements)}`);

      const verifyResult = await facilitator.verify(paymentPayload, requirements);
      console.log(`[x402] Verify result: isValid=${verifyResult.isValid}, reason=${verifyResult.invalidReason}`);

      if (!verifyResult.isValid) {
        console.error(`[x402] Verification failed: ${verifyResult.invalidReason}`);
        return NextResponse.json(
          sanitizeBigInts({ error: "Payment verification failed", reason: verifyResult.invalidReason }),
          { status: 402 }
        );
      }

      const settleResult = await facilitator.settle(paymentPayload, requirements);
      console.log(`[x402] Settle result: success=${settleResult.success}, tx=${settleResult.transaction}`);

      if (!settleResult.success) {
        console.error(`[x402] Settlement failed: ${settleResult.errorReason}`);
        return NextResponse.json(
          sanitizeBigInts({ error: "Payment settlement failed", reason: settleResult.errorReason }),
          { status: 402 }
        );
      }

      const amountUsdc = (Number(requirements.amount) / 1e6).toString();
      const payer = settleResult.payer ?? verifyResult.payer ?? "unknown";

      // Log to PaymentLog (optional)
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
        // Don't fail the request if logging fails
      }

      console.log(`[x402] Settled: ${endpoint} — ${amountUsdc} USDC from ${payer}`);

      // Execute the actual route handler
      const response = await handler(req);

      // Forward settlement confirmation header
      const settleResponseHeader = Buffer.from(
        JSON.stringify(sanitizeBigInts({
          success: true,
          transaction: settleResult.transaction,
          network: requirements.network,
          payer,
        }))
      ).toString("base64");

      response.headers.set("PAYMENT-RESPONSE", settleResponseHeader);
      return response;
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[x402] Payment processing error:", error);
      return NextResponse.json(
        { error: "Payment processing error", message },
        { status: 500 }
      );
    }
  };
}