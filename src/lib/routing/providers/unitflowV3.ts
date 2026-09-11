// src/lib/routing/providers/unitflowV3.ts
//
// UnitFlow V3 provider boundary — Phase 1 (adapter structure only).
//
// Explicitly OUT OF SCOPE in Phase 1:
//   - No UniversalRouter execution (no execute() call anywhere here).
//   - No transaction building, no signing payloads, no wallet flow.
//   - No on-chain swap execution.
//
// Live-contract investigation status (docs only, NO live probe in Phase 1):
//   - UnitFlow docs (docs.unitflow.finance/docs/dev/contracts + /docs/versions/v3)
//     list a V3 Quoter at 0x121aeB6DEf00F6F67665008CaC1C19805886ed1a with
//     Factory 0xAb6A8AAb7d490007634ef59d424b5d89688a1971.
//   - The UnitFlowV3-contract repo README lists a DIFFERENT Quoter at
//     0x09ea20bC7Fbb42C202b2Fa108365ccB15165Dc53 (Factory 0xb0bCabE107e9e37b34900667fa4ded4Df7e910CB).
//   - Neither source publishes a verified Quoter function signature here, and
//     the two Quoter addresses conflict, so documentation is NOT assumed
//     correct. The exact Quoter interface/signature MUST be confirmed against
//     the deployed contract with a read-only probe in Phase 2 before any
//     quoting use. Evidence: docs fetched 2026-09-11; conflict recorded,
//     probe deferred (foundation not blocked on execution details).
//   - UniversalRouter 0xEaF3195bE51861632cd32850973C9515DA48e76F is noted for
//     Phase 2 scoping only and is never called from this module.
//
// Until that probe lands, quote() throws NOT_IMPLEMENTED (fail-closed).

import { getTokenBySymbol } from '../../tokens/supportedTokens';
import { routingError } from '../canonical';
import {
  notImplemented,
  type NormalizedProviderQuote,
  type QuoteContext,
  type SwapProvider,
  type UnsignedExecution,
} from './types';

/** Arc Testnet chain id for UnitFlow deployments (docs: 5042002). */
export const UNITFLOW_V3_CHAIN_ID = 5042002;

/**
 * UNVERIFIED Quoter candidates from public docs (see header). Neither is
 * trusted — the effective address comes ONLY from UNITFLOW_V3_QUOTER_ADDRESS.
 */
export const UNITFLOW_V3_QUOTER_CANDIDATES_UNVERIFIED = [
  '0x121aeB6DEf00F6F67665008CaC1C19805886ed1a', // docs.unitflow.finance contracts page
  '0x09ea20bC7Fbb42C202b2Fa108365ccB15165Dc53', // UnitFlowV3-contract repo README
] as const;

/** UniversalRouter address (Phase 2 scoping note only — NEVER called in Phase 1). */
export const UNITFLOW_UNIVERSAL_ROUTER_ADDRESS_UNVERIFIED =
  '0xEaF3195bE51861632cd32850973C9515DA48e76F';

/**
 * UNVERIFIED candidate Quoter read ABI (Uniswap-V3-style exactInputSingle).
 * Recorded for Phase 2 probe design only — not called in Phase 1 and not
 * assumed to match the deployed contract.
 */
export const UNITFLOW_V3_QUOTER_READ_ABI_UNVERIFIED = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOut', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'amountIn', type: 'uint256' },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

export interface UnitFlowV3Config {
  quoterAddress: string;
  usdcAddress: string;
  eurcAddress: string;
}

function isAddress(v: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(v);
}

/**
 * Resolve UnitFlow V3 adapter config. Fails closed: the Quoter address has
 * no trusted default (public docs conflict), so UNITFLOW_V3_QUOTER_ADDRESS
 * is required. Token addresses resolve through the existing network-aware
 * utilities (never hardcoded here).
 */
export function getUnitFlowV3Config(
  env: Record<string, string | undefined> = process.env
): UnitFlowV3Config {
  const quoterAddress = (env.UNITFLOW_V3_QUOTER_ADDRESS ?? '').trim();
  if (!isAddress(quoterAddress)) {
    throw routingError(
      503,
      '[unitflow-v3] UnitFlow V3 quoting is not configured (UNITFLOW_V3_QUOTER_ADDRESS missing or malformed; no default — public docs conflict).'
    );
  }
  return {
    quoterAddress,
    usdcAddress: getTokenBySymbol('USDC').address,
    eurcAddress: getTokenBySymbol('EURC').address,
  };
}

/** UnitFlow V3 provider boundary — structure only; all ops throw in Phase 1. */
export class UnitFlowV3Provider implements SwapProvider {
  readonly venueId = 'unitflow-v3' as const;
  quote(_ctx: QuoteContext): Promise<NormalizedProviderQuote> {
    return Promise.reject(
      notImplemented(
        'unitflow-v3',
        'quote() — V3 Quoter interface unconfirmed on-chain (read-only probe required in Phase 2)'
      )
    ) as Promise<NormalizedProviderQuote>;
  }
  buildExecution(): Promise<UnsignedExecution> {
    return Promise.reject(notImplemented('unitflow-v3', 'buildExecution()')) as Promise<UnsignedExecution>;
  }
  verifyExecution(): Promise<unknown> {
    return Promise.reject(notImplemented('unitflow-v3', 'verifyExecution()')) as Promise<unknown>;
  }
}
