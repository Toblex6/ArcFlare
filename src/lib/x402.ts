/**
 * src/lib/x402.ts
 *
 * REBUILT using the ACTUAL @circle-fin/x402-batching SDK classes, per the
 * official SDK Reference. Replaces every hand-rolled version from earlier
 * today — those manually built payment requirements and were missing
 * extra.verifyingContract, which the SDK explicitly warns is required:
 *
 *   "Gateway clients require extra.verifyingContract to construct valid
 *    EIP-712 signatures. GatewayEvmScheme preserves this data."
 *
 * This is the documented seller-side usage pattern, verbatim from the
 * SDK Reference's own usage example, adapted to Next.js route handlers.
 */

import { NextRequest, NextResponse } from "next/server";
import { x402ResourceServer } from "@x402/core/server"; // confirmed correct path from Circle's own npm package page
import { BatchFacilitatorClient, GatewayEvmScheme } from "@circle-fin/x402-batching/server";
import { prisma } from "@/lib/prisma";

export const sellerAddress = process.env.SELLER_WALLET_ADDRESS as `0x${string}`;

// Single shared server instance, initialized once
let serverInstance: any = null;
let initPromise: Promise<void> | null = null;

async function getServer() {
  if (!serverInstance) {
    serverInstance = new x402ResourceServer([new BatchFacilitatorClient()]);
    serverInstance.register("eip155:*", new GatewayEvmScheme());
    initPromise = serverInstance.initialize();
  }
  if (initPromise) await initPromise;
  return serverInstance;
}

// NextResponse.json() calls JSON.stringify() internally, which cannot
// serialize BigInt values natively. The SDK's responseBody may contain
// BigInt amounts (e.g. atomic USDC units) — recursively convert any
// BigInt to a string before handing the object to NextResponse.json().
function sanitizeBigInts(obj: any): any {
  if (typeof obj === "bigint") return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeBigInts);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, sanitizeBigInts(v)]));
  }
  return obj;
}

/**
 * Wraps a Next.js route handler with Circle Gateway payment verification,
 * using the REAL SDK server (not hand-rolled fetch calls).
 */
export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  return async (req: NextRequest) => {
    const server = await getServer();

    // x402ResourceServer works against the standard Request/Response model —
    // Next.js's NextRequest extends Request, so this passes through directly.
    const result = await server.verifyPayment(req as unknown as Request, {
      price,
      payTo: sellerAddress,
    });

    if (!result.isValid) {
      console.log(`[x402] 402 Payment Required: ${endpoint}`);
      return NextResponse.json(sanitizeBigInts(result.responseBody), {
        status: 402,
        headers: result.responseHeaders || {},
      });
    }

    const settleResult = await server.settlePayment(result);

    if (!settleResult.success) {
      console.error(`[x402] Settlement failed for ${endpoint}: ${settleResult.errorReason}`);
      return NextResponse.json(
        sanitizeBigInts({ error: "Payment settlement failed", reason: settleResult.errorReason }),
        { status: 402 },
      );
    }

    const amountUsdc = settleResult.formattedAmount || "unknown";
    const payer = settleResult.payer ?? "unknown";

    try {
      await prisma.paymentLog.create({
        data: {
          reference: `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          amount: parseFloat(amountUsdc) || 0,
          currency: "USDC",
          chain: "Arc Testnet (x402 Gateway Nanopayment)",
          senderEmail: payer,
          merchant: endpoint,
          status: "SUCCESS",
          arcTxHash: settleResult.transaction ?? null,
        },
      });
    } catch (logErr) {
      console.error("Failed to log x402 payment to Postgres:", logErr);
    }

    console.log(`[x402] Payment settled: ${endpoint} — ${amountUsdc} USDC from ${payer}`);

    const response = await handler(req);
    response.headers.set(
      "PAYMENT-RESPONSE",
      Buffer.from(JSON.stringify({ success: true, transaction: settleResult.transaction, payer })).toString("base64"),
    );
    return response;
  };
}