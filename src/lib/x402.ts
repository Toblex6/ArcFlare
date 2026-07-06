
import { NextRequest, NextResponse } from "next/server";
import { x402ResourceServer } from "@x402/core/server";
import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";
import { prisma } from "@/lib/prisma";

export const sellerAddress = process.env.SELLER_WALLET_ADDRESS as `0x${string}`;

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

let _server: any = null;

async function getServer() {
  if (!_server) {
    _server = new x402ResourceServer([new BatchFacilitatorClient()]);
    await _server.initialize();
  }
  return _server;
}

export function withGateway(
  handler: (req: NextRequest) => Promise<NextResponse>,
  price: string,
  endpoint: string,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    const server = await getServer();

    const result = await server.verifyPayment(req as unknown as Request, {
      price,
      payTo: sellerAddress,
      network: "eip155:5042002",
    });

    if (!result.isValid) {
      console.log(`[x402] 402 required: ${endpoint}`);
      return NextResponse.json(sanitizeBigInts(result.responseBody), {
        status: 402,
        headers: sanitizeBigInts(result.responseHeaders) || {},
      });
    }

    const settleResult = await server.settlePayment(result);

    if (!settleResult.success) {
      console.error(`[x402] Settlement failed: ${settleResult.errorReason}`);
      return NextResponse.json(
        sanitizeBigInts({ error: "Payment settlement failed", reason: settleResult.errorReason }),
        { status: 402 }
      );
    }

    const payer = settleResult.payer ?? "unknown";
    const amountUsdc = settleResult.formattedAmount ?? "0";

    prisma.paymentLog.create({
      data: {
        reference: `x402_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        amount: parseFloat(amountUsdc) || 0,
        currency: "USDC",
        chain: "Arc Testnet x402",
        senderEmail: payer,
        merchant: endpoint,
        status: "SUCCESS",
        arcTxHash: settleResult.transaction ?? null,
      },
    }).catch(console.error);

    console.log(`[x402] Settled ${endpoint} — ${amountUsdc} USDC from ${payer}`);

    const response = await handler(req);
    response.headers.set(
      "PAYMENT-RESPONSE",
      Buffer.from(
        JSON.stringify({ success: true, transaction: settleResult.transaction, payer })
      ).toString("base64")
    );
    return response;
  };
}
