// src/lib/routing/providers/types.ts
//
// Provider foundation for Tower + UnitFlow swap integration — Phase 1.
//
// Interfaces/types ONLY. No execution logic, no wallet, no transaction
// building, no signing, no RPC, no DB. Concrete venues implement
// `SwapProvider`; quote normalization lives in `./normalize.ts`.
//
// Canonical routing behavior (src/lib/routing/quoter.ts + canonical.ts +
// quoteMath.ts + verifier.ts) is untouched by this module — these types
// exist independently and are NOT wired into /api/payments/quote yet.

/** Known swap venues. `canonical` is the ArcFlare pool/router path. */
export type SwapVenueId = 'canonical' | 'tower' | 'unitflow-v3';

/** All venue ids recognized by the registry (fail-closed allowlist). */
export const KNOWN_VENUE_IDS: readonly SwapVenueId[] = ['canonical', 'tower', 'unitflow-v3'];

/** Server-resolved quote request for a provider (symbols only, never addresses). */
export interface QuoteContext {
  /** Pay-in symbol, e.g. 'USDC'. */
  inputSymbol: 'USDC' | 'EURC';
  /** Settlement symbol, e.g. 'EURC'. */
  outputSymbol: 'USDC' | 'EURC';
  /** Exact input in canonical Arc base units (6-decimal integer). */
  inputAmount: bigint;
  /** Slippage tolerance in basis points (provider hint only). */
  slippageBps?: number;
}

/** Canonical token view — always resolved server-side, never from provider claims. */
export interface ProviderTokenView {
  symbol: 'USDC' | 'EURC';
  address: string;
  /** Canonical Arc decimals. USDC and EURC are both 6 on Arc. */
  decimals: number;
}

/**
 * Provider quote normalized into canonical Arc base units.
 * Produced ONLY via normalize.ts — never constructed from raw provider
 * output by hand.
 */
export interface NormalizedProviderQuote {
  venueId: SwapVenueId;
  inputToken: ProviderTokenView;
  outputToken: ProviderTokenView;
  /** Echo of the requested exact input (canonical base units). */
  inputAmount: bigint;
  /** Provider's projected output (canonical base units). */
  quotedOutputAmount: bigint;
  /** Provider's guaranteed floor when supplied (canonical base units). */
  minOutputAmount?: bigint;
}

/**
 * Opaque execution handle — Phase 1 boundary marker.
 * No transaction building, signing, or dispatch exists in Phase 1, so this
 * type is intentionally unconstructible outside a future Phase 2 builder.
 */
export interface UnsignedExecution {
  readonly venueId: SwapVenueId;
  readonly phase: 'phase-2-only';
}

/** Sentinel error code for Phase 1 execution stubs. */
export const PROVIDER_NOT_IMPLEMENTED = 'NOT_IMPLEMENTED' as const;

/** Throw the Phase 1 execution stub error (no execution in this phase). */
export function notImplemented(venueId: string, operation: string): never {
  const err = new Error(
    `[${venueId}] ${operation} is ${PROVIDER_NOT_IMPLEMENTED} in Phase 1 (provider foundation only — no execution).`
  ) as Error & { code: typeof PROVIDER_NOT_IMPLEMENTED };
  (err as any).code = PROVIDER_NOT_IMPLEMENTED;
  throw err;
}

/**
 * Swap provider boundary. `quote()` is the only Phase 1 operation;
 * `buildExecution()` / `verifyExecution()` are stubs that MUST throw
 * NOT_IMPLEMENTED until Phase 2 (execution integration).
 */
export interface SwapProvider {
  readonly venueId: SwapVenueId;
  quote(ctx: QuoteContext): Promise<NormalizedProviderQuote>;
  buildExecution(...args: unknown[]): Promise<UnsignedExecution>;
  verifyExecution(...args: unknown[]): Promise<unknown>;
}
