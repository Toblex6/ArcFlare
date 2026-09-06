// src/lib/routing/verifier.ts
//
// Receipt analysis for routed settlements (Payment Routing v1). Pure
// functions over injected data — no RPC, no DB — so the full negative
// matrix is unit-testable without funds.
//
// A routed settlement is valid iff ONE PaymentRouted event in the receipt
// proves, simultaneously:
//   1. it was emitted by the canonical router (log address match),
//   2. tokenIn is the quoted pay token X (exact),
//   3. amountIn is the quoted input (exact — over/under-pay must re-quote),
//   4. tokenOut is the invoice settlement token Y (exact),
//   5. the pool named in the event is the canonical pool,
//   6. the recipient is the frozen merchantSCA,
//   7. actual output (recipient credit, per the router's balance-delta
//      accounting) >= committed minOutputAmount,
//   8. execution landed at or before quote expiry (block timestamp truth),
//   9. the quote is still live (QUOTED; EXECUTED only resumes the SAME tx),
//  10. the payer is a real third party (and matches the payment's known
//      payer when one is already recorded).
//
// Everything else — arbitrary ERC-20 transfers, pool Swapped events,
// foreign-router events, client-supplied amounts/tokens — is ignored and
// can never satisfy a routed invoice.

import { decodeEventLog } from 'viem';
import { routingError } from './canonical';

export const PAYMENT_ROUTED_ABI = [
  {
    name: 'PaymentRouted',
    type: 'event',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'tokenIn', type: 'address', indexed: true },
      { name: 'amountIn', type: 'uint256', indexed: false },
      { name: 'tokenOut', type: 'address', indexed: true },
      { name: 'amountOut', type: 'uint256', indexed: false },
      { name: 'recipient', type: 'address', indexed: false },
      { name: 'pool', type: 'address', indexed: false },
    ],
  },
] as const;

export interface RoutedEvent {
  payer: string;
  tokenIn: string;
  amountIn: bigint;
  tokenOut: string;
  amountOut: bigint;
  recipient: string;
  pool: string;
}

export interface ReceiptLogLike {
  address: string;
  topics: any;
  data: any;
}

// First PaymentRouted event emitted by the canonical router, or null.
// Logs from any other contract (tokens, pool, foreign routers) are skipped.
export function findRoutedEvent(logs: ReceiptLogLike[], routerAddress: string): RoutedEvent | null {
  const router = routerAddress.toLowerCase();
  for (const log of logs ?? []) {
    if (!log || log.address?.toLowerCase() !== router) continue;
    try {
      const decoded = decodeEventLog({ abi: PAYMENT_ROUTED_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'PaymentRouted') continue;
      const a = decoded.args as unknown as {
        payer: string; tokenIn: string; amountIn: bigint;
        tokenOut: string; amountOut: bigint; recipient: string; pool: string;
      };
      return {
        payer: a.payer, tokenIn: a.tokenIn, amountIn: a.amountIn,
        tokenOut: a.tokenOut, amountOut: a.amountOut, recipient: a.recipient, pool: a.pool,
      };
    } catch {
      continue; // not a PaymentRouted log — skip, never match
    }
  }
  return null;
}

export interface ConversionExpectation {
  status: string;
  inputTokenAddress: string;
  inputAmount: string;
  outputTokenAddress: string;
  minOutputAmount: string;
  quoteExpiresAt: Date | string;
  executionTxHash?: string | null;
}

export interface CheckRoutedParams {
  event: RoutedEvent;
  conversion: ConversionExpectation;
  settlementAddress: string;
  merchantSCA: string;
  canonicalPool: string;
  canonicalRouter: string;
  blockTimestampSec: number;
  knownPayer?: string | null; // concrete 0x payer already on the payment, if any
  allowExecutedResume?: boolean; // same-tx resume after a crash between EXECUTED and SUCCESS
}

export interface CheckedRouted {
  payer: string;
  actualInput: string;
  actualOutput: string;
}

const ZERO = '0x0000000000000000000000000000000000000000';

export function checkRoutedExecution(p: CheckRoutedParams): CheckedRouted {
  const { event, conversion } = p;
  const eq = (a: string, b: string) => a?.toLowerCase() === b?.toLowerCase();

  if (conversion.status === 'EXECUTED' && !p.allowExecutedResume) {
    throw routingError(409, 'This conversion quote is already consumed.');
  }
  if (conversion.status !== 'QUOTED' && !(conversion.status === 'EXECUTED' && p.allowExecutedResume)) {
    throw routingError(400, 'This conversion quote is no longer live — request a fresh quote.');
  }

  const expiresSec = Math.floor(new Date(conversion.quoteExpiresAt).getTime() / 1000);
  if (!(p.blockTimestampSec > 0) || p.blockTimestampSec > expiresSec) {
    throw routingError(400, 'Conversion quote expired before execution — request a fresh quote.');
  }

  if (!eq(event.tokenIn, conversion.inputTokenAddress)) {
    throw routingError(400, 'Routed tokenIn does not match the quoted pay token.');
  }
  if (event.amountIn !== BigInt(conversion.inputAmount)) {
    throw routingError(400, 'Routed input amount does not match the quote — re-quote for the new amount.');
  }
  if (!eq(event.tokenOut, p.settlementAddress)) {
    throw routingError(400, 'Routed tokenOut is not the invoice settlement token.');
  }
  if (!eq(event.pool, p.canonicalPool)) {
    throw routingError(400, 'Routed pool is not the canonical pool.');
  }
  if (!eq(event.recipient, p.merchantSCA)) {
    throw routingError(400, 'Routed recipient is not the invoiced merchant wallet.');
  }
  if (event.amountOut < BigInt(conversion.minOutputAmount)) {
    throw routingError(400, 'Routed output is below the quoted minimum.');
  }

  const payer = event.payer;
  if (!payer || eq(payer, ZERO)) throw routingError(400, 'Routed payer is not a real address.');
  for (const forbidden of [p.canonicalRouter, p.canonicalPool, event.tokenIn, event.tokenOut]) {
    if (eq(payer, forbidden)) throw routingError(400, 'Routed payer is not a real third-party payer.');
  }
  if (p.knownPayer && p.knownPayer.startsWith('0x') && !eq(payer, p.knownPayer)) {
    throw routingError(403, 'Routed payer does not match the payment payer.');
  }

  return { payer, actualInput: event.amountIn.toString(), actualOutput: event.amountOut.toString() };
}
