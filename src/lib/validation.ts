// src/lib/validation.ts
// Zod schemas for all routes — Priority 2

import { z } from 'zod';

const scaAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid 0x Ethereum address');

const usdcAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'Amount must be a positive number with up to 6 decimals')
  .refine((v) => parseFloat(v) > 0, 'Amount must be greater than 0');

// ── /api/payments/initialize ──────────────────────────────────────────────────
export const InitializeSchema = z.object({
  amount: z.union([z.string(), z.number()]).transform(String).pipe(usdcAmount),
  // Strict USDC-only enum: exact match, uppercase, no fuzzy/case-insensitive
  // acceptance. Other currencies are NOT deployable yet (SwapPool has no
  // liquidity, the EURC path isn't wired into settle/verify) — expanding
  // this enum is a future task when multi-currency actually goes live.
  //
  // Phase 1 (multicurrency read-model): EURC is accepted so initialization
  // can RECORD a EURC-denominated invoice, but actual EURC settlement/transfer
  // is NOT enabled. `tokenAddress`, when provided, must be a supported token
  // (resolved via resolveCurrency); otherwise the symbol alone is canonical.
  //
  // Routing v1 note: the schema default stays USDC (legacy callers
  // unchanged). Merchant preference inheritance is keyed off EXPLICIT input:
  // the initialize handler peeks at the raw body — a merchant that names no
  // token inherits their default preference (NULL = USDC). Explicit input
  // always wins.
  currency: z.enum(['USDC', 'EURC']).default('USDC'),
  // Canonical ERC-20 address of the settlement token. Optional for USDC (USDC
  // remains the legacy default); when present it MUST match a supported token.
  tokenAddress: scaAddress.optional(),
  email: z.string().email().optional(),
  merchant: z.string().min(1).max(100).optional(),
  agentSCA: scaAddress.optional(),
  webhookUrl: z.string().url().optional(),
  // Explicit payout destination for consumer-initiated links (Flow send/request).
  // Never trust `merchant` (a free-text label) for routing funds.
  payoutAddress: scaAddress.optional(),
  // "send": the logged-in consumer IS the payer.
  // "request": the logged-in consumer is asking to BE PAID — there is no
  // real payer until someone actually opens the link and settles it.
  // Explicit instead of inferred, so the server never has to guess.
  direction: z.enum(['send', 'request']).optional(),
});

// ── /api/payments/settle ──────────────────────────────────────────────────────
export const SettleSchema = z.object({
  reference: z.string().min(1).max(100),
  messageHash: z
    .string()
    .regex(/^0x[a-fA-F0-9]+$/)
    .optional(),
});

// ── /api/payments/quote ───────────────────────────────────────────────────────
// Payment Routing v1: the client may name ONLY the payment reference and the
// desired pay-in symbol. Rates, outputs, minOuts, pools, routes, and token
// addresses are server-determined — any such keys in the body are stripped
// (zod default) and never reach the quoter.
export const QuoteSchema = z.object({
  reference: z.string().min(1).max(128),
  payToken: z.string().min(1).max(16),
  // Optional symbolic venue hint for the shared swap service. Absent =
  // canonical (existing behavior unchanged). 'tower' is rejected (quote-
  // only venue, never checkout execution); 'unitflow-v3' selects the
  // UnitFlow branch only when its opt-in flag is enabled (fail-closed).
  venue: z.string().min(1).max(32).optional(),
});

// ── /api/swap/* (Flow Swap backend — authenticated consumer session) ────────
// The client supplies symbols + decimal amounts only. Addresses, pools,
// fees, recipients, payers, and unsigned-tx construction are all
// server-resolved via the shared swap service (src/lib/swap/service.ts).
const swapSymbol = z.string().min(1).max(16);
const swapAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'Amount must be a positive number with up to 6 decimals')
  .refine((v) => parseFloat(v) > 0, 'Amount must be greater than 0');
const txHash = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Must be a valid 0x transaction hash');

export const SwapQuoteSchema = z.object({
  inputSymbol: swapSymbol,
  outputSymbol: swapSymbol,
  amount: swapAmount,
});

export const SwapExecuteIntentSchema = z
  .object({
    intentId: z.string().uuid().optional(),
    quoteHash: txHash.optional(),
    wrapTxHash: txHash.optional(),
    executionTxHash: txHash,
  })
  .refine((d) => d.intentId || d.quoteHash, 'intentId or quoteHash is required.');

export const SwapVerifySchema = z
  .object({
    intentId: z.string().uuid().optional(),
    quoteHash: txHash.optional(),
    wrapTxHash: txHash.optional(),
    executionTxHash: txHash.optional(),
  })
  .refine((d) => d.intentId || d.quoteHash, 'intentId or quoteHash is required.');

// ── /api/swap/unwrap + /api/swap/verify-unwrap (WUSDC→native-USDC exit) ─────
// EURC→USDC Flow Swaps credit WUSDC first; the unwrap exit burns exactly the
// verified proceeds into native USDC. Amounts are never client-supplied —
// both routes resolve the exact wad from the EXECUTED intent server-side.
export const SwapUnwrapSchema = z
  .object({
    intentId: z.string().uuid().optional(),
    quoteHash: txHash.optional(),
  })
  .refine((d) => d.intentId || d.quoteHash, 'intentId or quoteHash is required.');

export const SwapUnwrapVerifySchema = z
  .object({
    intentId: z.string().uuid().optional(),
    quoteHash: txHash.optional(),
    unwrapTxHash: txHash,
  })
  .refine((d) => d.intentId || d.quoteHash, 'intentId or quoteHash is required.');

// ── POST /api/swap/execute (server-executed CIRCLE swap) ───────────────────
// CIRCLE consumers only: the client names a live intent (from POST
// /api/swap/quote) and the server broadcasts every step from the consumer's
// own Circle SCA, then verifies on-chain. Amounts, tokens, pools, calldata,
// and recipients are all server-resolved from the stored intent binding —
// the locator is the only client input. EXTERNAL wallets keep the
// browser-signing flow (quote → sign → execute-intent → verify).
export const SwapServerExecuteSchema = z
  .object({
    intentId: z.string().uuid().optional(),
    quoteHash: txHash.optional(),
  })
  .refine((d) => d.intentId || d.quoteHash, 'intentId or quoteHash is required.');

// ── /api/merchant/me (PATCH settlement preference) ───────────────────────────
// Routing v1: merchants choose the default settlement token for FUTURE
// invoices. Symbol, address, or both (both must agree). Persisted value is
// always the resolver-canonical address; existing invoices are untouched.
export const SettlementPreferenceSchema = z.object({
  settlementToken: z.string().min(1).max(16).optional(),
  settlementTokenAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, 'Must be a valid 0x Ethereum address')
    .optional(),
});

// ── /api/escrow/create ────────────────────────────────────────────────────────
export const EscrowCreateSchema = z.object({
  depositorSCA: scaAddress,
  depositorWalletId: z.string().uuid('Must be a valid Circle wallet ID'),
  beneficiarySCA: scaAddress,
  amount: usdcAmount,
  deadlineHours: z.number().int().min(1).max(8760).default(24),
  condition: z.string().max(500).optional(),
  webhookUrl: z.string().url().optional(),
});

// ── /api/payments/stream ──────────────────────────────────────────────────────
export const StreamCreateSchema = z
  .object({
    senderSCA: scaAddress,
    receiverSCA: scaAddress,
    ratePerSecond: usdcAmount,
    totalDeposited: usdcAmount,
    webhookUrl: z.string().url().optional(),
  })
  .refine(
    (d) => parseFloat(d.totalDeposited) >= parseFloat(d.ratePerSecond),
    'totalDeposited must be at least ratePerSecond'
  );

export const StreamStopSchema = z.object({
  reference: z.string().min(1).max(100),
  callerSCA: scaAddress,
});

export const StreamWithdrawSchema = z.object({
  reference: z.string().min(1).max(100),
  receiverSCA: scaAddress,
});

// ── /api/payments/nano ────────────────────────────────────────────────────────
export const NanoSchema = z.object({
  agentSCA: scaAddress,
  merchantSCA: scaAddress,
  amount: usdcAmount,
  description: z.string().max(200).optional(),
});

export const NanoSettleSchema = z.object({
  agentSCA: scaAddress,
  merchantSCA: scaAddress,
  webhookUrl: z.string().url().optional(),
  forceSettle: z.boolean().default(false),
  autoSettle: z.boolean().default(false),
});

// ── /api/agent/deploy ─────────────────────────────────────────────────────────
export const AgentDeploySchema = z.object({
  agentName: z.string().min(1).max(100).default('FlareHQ Autonomous Agent'),
  metadataUri: z
    .string()
    .url()
    .or(z.string().startsWith('ipfs://'))
    .default('ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei'),
  ownerNode: z.string().optional(),
});

// ── Helper: parse and return 400 on failure ───────────────────────────────────
export function parseBody<T>(
  schema: z.ZodSchema<T>,
  body: unknown
): { data: T; error: null } | { data: null; error: Response } {
  const result = schema.safeParse(body);
  if (!result.success) {
    const messages = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    return {
      data: null,
      error: new Response(
        JSON.stringify({ success: false, error: `Validation failed: ${messages}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    };
  }
  return { data: result.data, error: null };
}
