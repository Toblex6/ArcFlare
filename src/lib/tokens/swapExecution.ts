/**
 * swapExecution.ts
 *
 * Backend wiring for USDC <-> EURC swaps via ArcFlareSwapPool.sol.
 * Same relayer pattern as the rest of the codebase — user doesn't need
 * gas, relayer submits on their behalf after verifying caller identity.
 */

import type { NextRequest } from "next/server";
import { verifyCallerControlsAddress, type CallerRole } from "@/lib/auth/verifyCallerControlsAddress";
import { getRelayerSigner } from "@/lib/wallet/jobEscrowClient";
import { getTokenBySymbol } from "@/lib/tokens/supportedTokens";
import { parseEventValue } from "@/lib/contracts/receiptParser";
import { Contract } from "ethers";

const SWAP_POOL_CONTRACT_ADDRESS = process.env.SWAP_POOL_CONTRACT_ADDRESS ?? "";

const SWAP_POOL_ABI = [
  "function swap(address tokenIn, uint256 amountIn, uint256 minAmountOut) external returns (uint256 amountOut)",
  "function getQuote(address tokenIn, uint256 amountIn) external view returns (uint256 amountOut)",
  "event Swapped(address indexed trader, address tokenIn, uint256 amountIn, uint256 amountOut)",
];

function getSwapPoolContract(): Contract {
  if (!SWAP_POOL_CONTRACT_ADDRESS) {
    throw new Error("SWAP_POOL_CONTRACT_ADDRESS is not configured — deploy and seed ArcFlareSwapPool.sol first");
  }
  return new Contract(SWAP_POOL_CONTRACT_ADDRESS, SWAP_POOL_ABI, getRelayerSigner());
}

export interface SwapQuoteParams {
  fromSymbol: "USDC" | "EURC";
  toSymbol: "USDC" | "EURC";
  amountIn: bigint;
}

/**
 * Read-only quote — call this BEFORE swapExactIn so your UI can show the
 * user an expected output and let them set a slippage tolerance, instead
 * of them swapping blind.
 */
export async function getSwapQuote(params: SwapQuoteParams): Promise<bigint> {
  const { fromSymbol, amountIn } = params;
  const fromToken = getTokenBySymbol(fromSymbol);
  const pool = getSwapPoolContract();
  const quote = await pool.getQuote(fromToken.address, amountIn);
  return BigInt(quote);
}

export interface SwapExecutionParams {
  req: NextRequest;
  callerAddress: string; // claimed; verified below
  callerRole: CallerRole; // merchant | consumer | agent — swap should be usable by any of these
  fromSymbol: "USDC" | "EURC";
  toSymbol: "USDC" | "EURC";
  amountIn: bigint;
  slippageBps: number; // e.g. 100 = 1% tolerance — REQUIRED, no silent zero-slippage default
}

export interface SwapExecutionResult {
  txHash: string;
  amountOut: string; // actual amount received, from the Swapped event
}

/**
 * Executes a swap on behalf of the caller via the relayer. Caller must
 * have already approved SWAP_POOL_CONTRACT_ADDRESS to spend their tokenIn
 * — OR this needs a fund-forwarding step similar to fundJobFor's pattern
 * if the caller is paying via x402 rather than holding tokens directly in
 * their own wallet already. Flagging this: unlike job funding, a swap
 * assumes the user ALREADY HOLDS the token they're swapping FROM — it's
 * not itself an x402-payable action, since x402 pays for services, not for
 * converting your own existing balance. Confirm this matches your intended
 * UX (e.g. "swap my existing USDC balance to EURC" is the expected flow,
 * not "pay me and I'll give you EURC").
 */
export async function executeSwap(params: SwapExecutionParams): Promise<SwapExecutionResult> {
  const { req, callerAddress, callerRole, fromSymbol, toSymbol, amountIn, slippageBps } = params;

  if (slippageBps <= 0 || slippageBps > 2000) {
    // hard sanity bound — reject absurd or missing slippage tolerance
    // rather than letting a 0 (no protection) or 100% (meaningless) value
    // through silently
    throw new Error("slippageBps must be between 1 and 2000 (0.01%–20%)");
  }
  if (fromSymbol === toSymbol) {
    throw new Error("fromSymbol and toSymbol must differ");
  }

  const callerCheck = await verifyCallerControlsAddress(req, callerAddress, { role: callerRole });
  if (!callerCheck.ok) {
    throw new Error(`caller verification failed: ${callerCheck.reason}`);
  }

  const fromToken = getTokenBySymbol(fromSymbol);

  const expectedOut = await getSwapQuote({ fromSymbol, toSymbol, amountIn });
  const minAmountOut = (expectedOut * BigInt(10_000 - slippageBps)) / BigInt(10_000);

  const pool = getSwapPoolContract();
  const tx = await pool.swap(fromToken.address, amountIn, minAmountOut);
  const receipt = await tx.wait();

  const amountOut = extractAmountOutFromReceipt(receipt);

  return { txHash: receipt.hash, amountOut: amountOut.toString() };
}

function extractAmountOutFromReceipt(receipt: any): bigint {
  // Shared helper — Swapped.amountOut is non-indexed, parseEventValue
  // handles both indexed and non-indexed fields by name.
  return parseEventValue(receipt, SWAP_POOL_ABI, "Swapped", "amountOut");
}