// src/lib/gateway-middleware.ts
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
  priceUSDC: string;
}

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

export function requireGatewayPayment(
  options: RequirePaymentOptions,
  handler: (req: NextRequest, payment: GatewayPaymentContext) => Promise<NextResponse>
) {
  const gateway = getGateway(options.sellerAddress);
  const priceTag = `$${options.priceUSDC}`;
  const middleware = gateway.require(priceTag);

  return function wrappedHandler(req: NextRequest): Promise<NextResponse> {
    return new Promise<NextResponse>((resolve) => {
      const expressLikeReq: any = {
        headers: Object.fromEntries(req.headers.entries()),
        method: req.method,
        originalUrl: req.nextUrl.pathname + req.nextUrl.search,
        url: req.nextUrl.pathname + req.nextUrl.search,
        payment: undefined,
      };

      let statusCode = 200;
      let responseBody: any = null;
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
        end() {
          if (responseBody === null) {
            resolve(new NextResponse(null, { status: statusCode, headers: responseHeaders }));
          }
        },
        send(body: any) {
          responseBody = body;
          // ✅ Intercept: if payment-required header exists and status is 200, convert to 402
          if (responseHeaders['payment-required'] && statusCode === 200) {
            const base64 = responseHeaders['payment-required'];
            try {
              const decoded = Buffer.from(base64, 'base64').toString('utf-8');
              const json = JSON.parse(decoded);
              // Set status to 402 and return the JSON as body
              resolve(NextResponse.json(json, { status: 402, headers: responseHeaders }));
              return;
            } catch (e) {
              // fallback: keep as is
            }
          }
          // If it's a string, send as text; else as JSON
          if (typeof body === 'string') {
            resolve(new NextResponse(body, { status: statusCode, headers: responseHeaders }));
          } else {
            resolve(NextResponse.json(body, { status: statusCode, headers: responseHeaders }));
          }
        },
        json(body: any) {
          responseBody = body;
          // Same interception
          if (responseHeaders['payment-required'] && statusCode === 200) {
            const base64 = responseHeaders['payment-required'];
            try {
              const decoded = Buffer.from(base64, 'base64').toString('utf-8');
              const json = JSON.parse(decoded);
              resolve(NextResponse.json(json, { status: 402, headers: responseHeaders }));
              return;
            } catch (e) {
              // fallback
            }
          }
          resolve(NextResponse.json(body, { status: statusCode, headers: responseHeaders }));
        },
        getHeader(key: string) {
          return responseHeaders[key];
        },
        removeHeader(key: string) {
          delete responseHeaders[key];
        },
      };

      try {
        middleware(expressLikeReq, expressLikeRes, async () => {
          const payment: GatewayPaymentContext = expressLikeReq.payment || {
            payer: "unknown",
            amount: priceToAtomicUnits(options.priceUSDC),
            network: ARC_TESTNET_NETWORK,
          };
          try {
            const result = await handler(req, payment);
            if (result) {
              resolve(result);
            } else {
              resolve(NextResponse.json({ success: true, payment }, { status: 200 }));
            }
          } catch (handlerErr) {
            resolve(NextResponse.json({ error: String(handlerErr) }, { status: 500 }));
          }
        });
      } catch (middlewareErr) {
        resolve(NextResponse.json({ error: String(middlewareErr) }, { status: 500 }));
      }
    });
  };
}

function priceToAtomicUnits(priceUSDC: string): string {
  return Math.round(parseFloat(priceUSDC) * 1_000_000).toString();
}