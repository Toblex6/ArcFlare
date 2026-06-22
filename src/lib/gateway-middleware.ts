// src/lib/gateway-middleware.ts
// OFFICIAL Circle Gateway x402 middleware — uses Circle's maintained
// @circle-fin/x402-batching package. This REPLACES every prior hand-rolled
// version that guessed at /verify, /settle, /v1/payment/verify, /v1/x402/verify
// paths — none of those exist. This package is the only supported integration.
//
// Source: https://www.circle.com/blog/turn-your-api-into-a-storefront-for-agents
//
// Install first:
//   npm install @circle-fin/x402-batching viem

import { NextRequest, NextResponse } from "next/server";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";

const ARC_TESTNET_NETWORK = "eip155:5042002";

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

// Single shared gateway instance — created once per process, not per request
let gatewaySingleton: ReturnType<typeof createGatewayMiddleware> | null = null;

function getGateway(sellerAddress: string) {
  if (!gatewaySingleton) {
    gatewaySingleton = createGatewayMiddleware({
      sellerAddress,
      facilitatorUrl: "https://gateway-api-testnet.circle.com",
      networks: [ARC_TESTNET_NETWORK],
    });
  }
  return gatewaySingleton;
}

/**
 * Wraps a Next.js route handler with Circle's official Gateway middleware.
 * The underlying package is built for Express (req, res, next) — this
 * adapter bridges that contract to a Next.js Request/Response cycle.
 */
export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  const gateway = getGateway(options.sellerAddress);
  const priceTag = `$${options.priceUSDC}`;
  const middleware = gateway.require(priceTag);

  return function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    return new Promise<NextResponse>((resolve, reject) => {
      // Minimal Express-compatible req/res shim
      const expressLikeReq: any = {
        headers: Object.fromEntries(req.headers.entries()),
        method: req.method,
        originalUrl: req.nextUrl.pathname + req.nextUrl.search,
        url: req.nextUrl.pathname + req.nextUrl.search,
        payment: undefined,
      };

      let statusCode = 200;
      const responseHeaders: Record<string, string> = {};

      const expressLikeRes: any = {
        status(code: number) {
          statusCode = code;
          return this;
        },
        setHeader(key: string, value: string) {
          responseHeaders[key] = value;
          return this;
        },
        json(payload: any) {
          resolve(NextResponse.json(payload, { status: statusCode, headers: responseHeaders }));
        },
        send(payload: any) {
          resolve(new NextResponse(payload, { status: statusCode, headers: responseHeaders }));
        },
      };

      try {
        middleware(expressLikeReq, expressLikeRes, async () => {
          // Payment verified by the official package — proceed to handler.
          const payment: GatewayPaymentContext = expressLikeReq.payment || {
            payer: "unknown",
            amount: priceToAtomicUnits(options.priceUSDC),
            network: ARC_TESTNET_NETWORK,
          };

          try {
            const result = await handler(req, payment);
            resolve(result);
          } catch (handlerErr) {
            reject(handlerErr);
          }
        });
      } catch (middlewareErr) {
        reject(middlewareErr);
      }
    });
  };
}

function priceToAtomicUnits(priceUSDC: string): string {
  return Math.round(parseFloat(priceUSDC) * 1_000_000).toString();
}