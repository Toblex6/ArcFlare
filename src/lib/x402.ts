
/**
 * src/lib/x402.ts
 *
 * VERIFIED — copied directly from Circle's own reference implementation
 * at github.com/circlefin/arc-nanopayments/blob/master/lib/x402.ts,
 * adapted only to remove the Supabase logging dependency (ArcFlare already
 * has Postgres/Prisma — logging is wired separately below) and to use
 * ArcFlare's own SELLER_WALLET_ADDRESS env var name.
 *
 * This REPLACES every prior guessed version. The critical corrections vs.
 * everything tried before today:
 *   - extra.name is "GatewayWalletBatched", NOT "USDC"
 *   - extra.verifyingContract is the Gateway Wallet contract address,
 *     NOT the USDC token address
 *   - PAYMENT-REQUIRED header carries base64-encoded JSON, not a plain body
 *   - Uses BatchFacilitatorClient.verify() + .settle() directly — no
 *     guessed REST paths, no Express shimming required
 *
 * Install:
 *   npm install @circle-fin/x402-batching viem
 */

import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Arc Testnet contract addresses — confirmed from Circle's own reference repo
const ARC_TESTNET_NETWORK = "eip155:5042002";
const ARC_TESTNET_USDC = "0x3600000000000000000000000000000000000000";
const ARC_TESTNET_GATEWAY_WALLET = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";

export const sellerAddress = process.env.SELLER_WALLET_ADDRESS as `0x${string}`;

const facilitator = new BatchFacilitatorClient();

interface PaymentPayload {
  x402Version: number;
  resource?: { url: string; description: string; mimeType: string };
  accepted?: Record<string, unknown>;
  payload: Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

function buildPaymentRequirements(price: string) {
  const amount = Math.round(parseFloat(price.replace("$", "")) * 1_000_000);

  return {
    scheme: "exact" as const,
    network: ARC_TESTNET_NETWORK,
    asset: ARC_TESTNET_USDC,
    amount: amount.toString(),
    payTo: sellerAddress,
    maxTimeoutSeconds: 345600,
    extra: {
      name: "GatewayWalletBatched",
      version: "1",
      verifyingContract: ARC_TESTNET_GATEWAY_WALLET,
    },
  };
}

/**
 * Wraps a Next.js route handler with Circle Gateway payment verification.
 * Exact pattern from Circle's own arc-nanopayments reference app.
 */
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
            JSON.stringify(paymentRequired),
          ).toString("base64"),
        },
      });
    }

    try {
      const paymentPayload: PaymentPayload = JSON.parse(
        Buffer.from(paymentSignature, "base64").toString("utf-8"),
      );

      const verifyResult = await facilitator.verify(paymentPayload, requirements);

      if (!verifyResult.isValid) {
        return NextResponse.json(
          { error: "Payment verification failed", reason: verifyResult.invalidReason },
          { status: 402 },
        );
      }

      const settleResult = await facilitator.settle(paymentPayload, requirements);

      if (!settleResult.success) {
        console.error(`[x402] Settlement failed for ${endpoint}: ${settleResult.errorReason}`);
        return NextResponse.json(
          { error: "Payment settlement failed", reason: settleResult.errorReason },
          { status: 402 },
        );
      }

      const amountUsdc = (Number(requirements.amount) / 1e6).toString();
      const payer = settleResult.payer ?? verifyResult.payer ?? "unknown";

      // ── ArcFlare-specific: log via Prisma instead of Supabase ──────────────
      try {
        await (prisma as any).paymentLog.create({
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
        console.error("Failed to log x402 payment to Postgres:", logErr);
      }

      console.log(`[x402] Payment settled: ${endpoint} — ${amountUsdc} USDC from ${payer}`);

      const response = await handler(req);

      const settleResponseHeader = Buffer.from(
        JSON.stringify({
          success: true,
          transaction: settleResult.transaction,
          network: requirements.network,
          payer,
        }),
      ).toString("base64");

      response.headers.set("PAYMENT-RESPONSE", settleResponseHeader);
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[x402] Payment processing error:", message);
      return NextResponse.json(
        { error: "Payment processing error", message },
        { status: 500 },
      );
    }
  };
}