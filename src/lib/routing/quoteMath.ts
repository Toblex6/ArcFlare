// src/lib/routing/quoteMath.ts
//
// Pure exact-integer quote math for Payment Routing v1. No floats, no RPC,
// no DB — unit-testable in isolation. Mirrors ArcFlareSwapPool's
// constant-product formula exactly (FEE_BPS must stay in sync with the pool).

import { encodePacked, keccak256 } from 'viem';
import {
  ROUTING_MAX_DEPTH_BPS,
  ROUTING_MAX_OUTPUT_BASE,
  routingError,
} from './canonical';

export const POOL_FEE_BPS = 30n; // must match ArcFlareSwapPool.FEE_BPS

// Exact pool output for an exact input (integer division rounds down, exactly
// like the pool — the quoter never promises a fractional unit).
export function poolQuoteOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) throw routingError(400, 'Quote input must be positive.');
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw routingError(503, 'Pool has no liquidity for this pair.');
  }
  const inWithFee = amountIn * (10_000n - POOL_FEE_BPS);
  return (inWithFee * reserveOut) / (reserveIn * 10_000n + inWithFee);
}

// Binding floor: pool quote minus slippage tolerance minus the measured
// final-leg fee buffer. This is what the router enforces as recipient credit
// and what the verifier checks actual output against.
export function discountForSlippage(quoted: bigint, slippageBps: number, outFeeBuffer: bigint): bigint {
  if (quoted <= 0n) throw routingError(400, 'Quote output must be positive.');
  const slip = (quoted * BigInt(slippageBps)) / 10_000n;
  const minOut = quoted - slip - outFeeBuffer;
  if (minOut <= 0n) throw routingError(400, 'Quote output too small to cover slippage and fees.');
  return minOut;
}

export interface DeriveQuoteInputParams {
  invoiceAmountY: bigint; // merchant settlement obligation, Y base units
  reserveIn: bigint;
  reserveOut: bigint;
  slippageBps: number;
  outFeeBuffer: bigint;
  maxOutputBase?: bigint;
  maxDepthBps?: number;
}

export interface DerivedQuote {
  inputAmount: bigint; // required X base units (exact-in)
  quotedOutput: bigint; // pool quote for inputAmount
  minOutput: bigint; // >= invoiceAmountY, enforced on recipient credit
}

// Minimal exact input whose discounted quote covers the invoice. Starts from
// the closed-form constant-product inversion (an underestimate — it ignores
// the pool fee) and bumps deterministically until the floor holds.
export function deriveQuoteInput(p: DeriveQuoteInputParams): DerivedQuote {
  const {
    invoiceAmountY,
    reserveIn,
    reserveOut,
    slippageBps,
    outFeeBuffer,
    maxOutputBase = ROUTING_MAX_OUTPUT_BASE,
    maxDepthBps = ROUTING_MAX_DEPTH_BPS,
  } = p;
  if (invoiceAmountY <= 0n) throw routingError(400, 'Invoice amount must be positive.');
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw routingError(503, 'Pool has no liquidity for this pair.');
  }
  if (invoiceAmountY + outFeeBuffer >= reserveOut) {
    throw routingError(400, 'Trade size exceeds pool depth for this pair.');
  }

  const need = invoiceAmountY + outFeeBuffer;
  // in = need*rIn/(rOut-need) inverted from need = in*rOut/(rIn+in); integer
  // division floors, so +1 keeps the start on the feasible side.
  let input = (need * reserveIn) / (reserveOut - need) + 1n;

  let quoted = 0n;
  let minOut = 0n;
  let settled = false;
  for (let i = 0; i < 2000; i++) {
    quoted = poolQuoteOut(input, reserveIn, reserveOut);
    const floor = quoted - (quoted * BigInt(slippageBps)) / 10_000n - outFeeBuffer;
    if (floor >= invoiceAmountY && floor > 0n) {
      minOut = floor;
      settled = true;
      break;
    }
    input += input / 500n + 1n;
  }
  if (!settled) throw routingError(400, 'Could not price this trade size against pool depth.');
  if (quoted > maxOutputBase) {
    throw routingError(400, 'Trade size exceeds the routing size cap.');
  }
  if (quoted * 10_000n > reserveOut * BigInt(maxDepthBps)) {
    throw routingError(400, 'Trade size exceeds pool depth for this pair.');
  }
  return { inputAmount: input, quotedOutput: quoted, minOutput: minOut };
}

// Deterministic quote hash binding reference + X/Y + amounts + expiry + the
// canonical pool/router. The verifier recomputes this — a client cannot
// substitute amounts, tokens, or venues without invalidating the quote.
export function computeQuoteHash(args: {
  reference: string;
  inputToken: string;
  inputAmount: bigint;
  outputToken: string;
  quotedOutput: bigint;
  minOutput: bigint;
  expiresAtSec: number;
  poolAddress: string;
  routerAddress: string;
}): `0x${string}` {
  return keccak256(
    encodePacked(
      ['string', 'address', 'uint256', 'address', 'uint256', 'uint256', 'uint256', 'address', 'address'],
      [
        args.reference,
        args.inputToken as `0x${string}`,
        args.inputAmount,
        args.outputToken as `0x${string}`,
        args.quotedOutput,
        args.minOutput,
        BigInt(args.expiresAtSec),
        args.poolAddress as `0x${string}`,
        args.routerAddress as `0x${string}`,
      ]
    )
  );
}
