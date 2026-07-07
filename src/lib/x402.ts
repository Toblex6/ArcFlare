
import { NextRequest, NextResponse } from "next/server";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { prisma } from "@/lib/prisma";

export const sellerAddress = process.env.SELLER_WALLET_ADDRESS as `0x${string}`;

const facilitator = new BatchFacilitatorClient();

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

function buildRequirements(price: string) {
  const amount = Math.round(parseFloat(price.replace("$", "")) * 1_000_000);
  return {
    scheme: "exact" as const,
    network: "eip155:5042002",
    asset: "0x3600000000000000000000000000000000000000",
    amount: amount.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: 604800,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
    },
  };
}

export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  const requirements = buildRequirements(price);

  return async (req: NextRequest): Promise<NextResponse> => {
    const paymentSignatureHeader = req.headers.get("payment-signature");

    // ── No payment — return 402 ────────────────────────────────────────────
    if (!paymentSignatureHeader) {
      console.log(`[x402] 402 required: ${endpoint} (${price})`);
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

    // ── Payment present — decode, verify, settle ──────────────────────────
    try {
      let paymentPayload: any;
      try {
        paymentPayload = JSON.parse(
          Buffer.from(paymentSignatureHeader, "base64").toString("utf-8")
        );
      } catch {
        return NextResponse.json(
          { error: "Invalid payment signature encoding." },
          { status: 402 }
        );
      }

      console.log(`[x402] Verifying payment for ${endpoint}...`);

      // Call verify directly on BatchFacilitatorClient
      const verifyResult = await facilitator.verify(paymentPayload, requirements);

      if (!verifyResult.isValid) {
        console.error(`[x402] Verify failed: ${verifyResult.invalidReason}`);
        return NextResponse.json(
          sanitizeBigInts({
            error: "Payment verification failed",
            reason: verifyResult.invalidReason,
          }),
          { status: 402 }
        );
      }

      console.log(`[x402] Verified. Settling...`);

      // Call settle directly on BatchFacilitatorClient
      const settleResult = await facilitator.settle(paymentPayload, requirements);

      if (!settleResult.success) {
        console.error(`[x402] Settle failed: ${settleResult.errorReason}`);
        return NextResponse.json(
          sanitizeBigInts({
            error: "Payment settlement failed",
            reason: settleResult.errorReason,
          }),
          { status: 402 }
        );
      }

      const payer = settleResult.payer ?? verifyResult.payer ?? "unknown";
      const amountUsdc = (Number(requirements.amount) / 1e6).toString();

      console.log(`[x402] Settled! ${amountUsdc} USDC from ${payer} tx: ${settleResult.transaction}`);

      // Log to DB — non-blocking
      prisma.paymentLog.create({
        data: {
          reference: `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          amount: parseFloat(amountUsdc),
          currency: "USDC",
          chain: "Arc Testnet x402",
          senderEmail: payer,
          merchant: endpoint,
          status: "SUCCESS",
          arcTxHash: settleResult.transaction ?? null,
        },
      }).catch((e) => console.error("[x402] DB log failed:", e.message));

      // Run the actual handler
      const response = await handler(req);

      response.headers.set(
        "PAYMENT-RESPONSE",
        Buffer.from(
          JSON.stringify({
            success: true,
            transaction: settleResult.transaction,
            network: requirements.network,
            payer,
          })
        ).toString("base64")
      );

      return response;
    } catch (error: any) {
      console.error("[x402] Error:", error.message);
      if (error.cause) console.error("[x402] Cause:", error.cause);
      return NextResponse.json(
        { error: "Payment processing error", message: error.message },
        { status: 500 }
      );
    }
  };
}
