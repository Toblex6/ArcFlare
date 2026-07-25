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
  currency: z.string().min(1).max(10).default('USDC'),
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
