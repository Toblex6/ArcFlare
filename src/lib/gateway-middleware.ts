
import { NextRequest, NextResponse } from "next/server";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import { formatUnits } from "viem";

const ARC_TESTNET_NETWORK = "eip155:5042002";
const FACILITATOR_URL = "https://gateway-api-testnet.circle.com";

export interface GatewayPaymentContext {
  payer: string;
  amount: string;
  network: string;
  transaction?: string;
}

interface RequirePaymentOptions {
  sellerAddress: string;
  priceUSDC: string; // e.g. "0.001" — formatted as "$0.001" internally
}

/**
 * Wraps a Next.js route handler with Circle's official Gateway x402
 * middleware. Returns 402 Payment Required if no valid payment is
 * present; calls the handler with payment details once verified.
 */
export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  const gateway = createGatewayMiddleware({
    sellerAddress: options.sellerAddress,
    facilitatorUrl: FACILITATOR_URL,
    networks: [ARC_TESTNET_NETWORK],
  });

  const priceTag = `$${options.priceUSDC}`;

  return async function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    // Adapt the official Express-style middleware to a Next.js route.
    // gateway.require() expects (req, res, next) — we simulate that
    // contract using a lightweight shim since Next.js route handlers
    // don't have res/next.
    return new Promise<NextResponse>((resolve) => {
      const fakeReq: any = {
        headers: Object.fromEntries(req.headers.entries()),
        method: req.method,
        url: req.nextUrl.pathname + req.nextUrl.search,
        body: undefined,
      };

      const fakeRes: any = {
        statusCode: 200,
        _headers: {} as Record<string, string>,
        setHeader(key: string, value: string) {
          this._headers[key] = value;
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: any) {
          resolve(
            NextResponse.json(payload, {
              status: this.statusCode,
              headers: this._headers,
            })
          );
        },
      };

      gateway.require(priceTag)(fakeReq, fakeRes, async () => {
        // Payment verified — fakeReq.payment is populated by the middleware
        const payment: GatewayPaymentContext = fakeReq.payment || {
          payer: "unknown",
          amount: priceToAtomicUnits(options.priceUSDC),
          network: ARC_TESTNET_NETWORK,
        };

        const result = await handler(req, payment);
        resolve(result);
      });
    });
  };
}

function priceToAtomicUnits(priceUSDC: string): string {
  return Math.round(parseFloat(priceUSDC) * 1_000_000).toString();
}
