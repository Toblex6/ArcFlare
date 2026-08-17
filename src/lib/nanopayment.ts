// src/lib/nanopayment.ts
// Nanopayment batching logic.
// Records micro-charges in Postgres without settling immediately.
// When threshold or time interval is reached, batches and settles via CCTP V2.

import { prisma } from '@/lib/prisma';

// ─── Config ───────────────────────────────────────────────────────────────────
export const NANO_BATCH_THRESHOLD_USDC = 1.0; // Settle when batch reaches 1 USDC
export const NANO_BATCH_INTERVAL_MS = 60000; // Or every 60 seconds

// ─── Record a single nanopayment ─────────────────────────────────────────────
export async function recordNanoPayment({
  agentSCA,
  merchantSCA,
  amount,
  description,
}: {
  agentSCA: string;
  merchantSCA: string;
  amount: number;
  description?: string;
}) {
  const nano = await prisma.nanoPayment.create({
    data: {
      agentSCA,
      merchantSCA,
      amount,
      description,
      settled: false,
    },
  });
  return nano;
}

// ─── Get total unsettled balance for an agent-merchant pair ──────────────────
export async function getUnsettledBalance(agentSCA: string, merchantSCA: string) {
  const unsettled = await prisma.nanoPayment.findMany({
    where: { agentSCA, merchantSCA, settled: false },
  });

  const total = unsettled.reduce((sum, n) => sum + n.amount, 0);
  return {
    total: parseFloat(total.toFixed(6)),
    count: unsettled.length,
    payments: unsettled,
  };
}

// ─── Check if batch threshold is reached ─────────────────────────────────────
export async function shouldBatchSettle(agentSCA: string, merchantSCA: string) {
  const { total } = await getUnsettledBalance(agentSCA, merchantSCA);
  return total >= NANO_BATCH_THRESHOLD_USDC;
}

// ─── Mark a batch as settled ──────────────────────────────────────────────────
export async function markBatchSettled(agentSCA: string, merchantSCA: string) {
  // Removed batchRef update since it doesn't exist in the current schema
  await prisma.nanoPayment.updateMany({
    where: { agentSCA, merchantSCA, settled: false },
    data: { settled: true },
  });
}

// ─── Get all unsettled pairs that need batching ───────────────────────────────
export async function getUnsettledPairs() {
  const unsettled = await prisma.nanoPayment.findMany({
    where: { settled: false },
    select: { agentSCA: true, merchantSCA: true },
    distinct: ['agentSCA', 'merchantSCA'],
  });
  return unsettled;
}

// ─── Get batch summary for a pair ─────────────────────────────────────────────
export async function getBatchSummary(agentSCA: string, merchantSCA: string) {
  const payments = await prisma.nanoPayment.findMany({
    where: { agentSCA, merchantSCA, settled: false },
    orderBy: { createdAt: 'asc' },
  });

  const total = payments.reduce((sum, n) => sum + n.amount, 0);
  const oldest = payments[0]?.createdAt;
  const ageMs = oldest ? Date.now() - new Date(oldest).getTime() : 0;

  return {
    agentSCA,
    merchantSCA,
    total: parseFloat(total.toFixed(6)),
    count: payments.length,
    ageMs,
    shouldSettle: total >= NANO_BATCH_THRESHOLD_USDC || ageMs >= NANO_BATCH_INTERVAL_MS,
    payments,
  };
}
