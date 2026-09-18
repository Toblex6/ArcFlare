// src/lib/bridge/stageLogger.ts
//
// Server-only append-only stage logger for EXTERNAL bridge attempts.
// Every meaningful transition on a FlowBridgeIntent is recorded with
// timestamp, txHash, chainId, raw errorDetail, and optional metadata.
//
// The current stage for a given intent is the latest row ordered by createdAt.
// This is purely observability — it never gates execution logic.

import { prisma } from '@/src/lib/prisma';

/**
 * Canonical stage values covering the full EXTERNAL bridge lifecycle.
 * Stored as text in the DB — not a PG enum — so adding new stages is
 * always additive and never requires a migration.
 */
export type BridgeStage =
  | 'PREPARING'
  | 'APPROVAL_PENDING'
  | 'APPROVAL_CONFIRMED'
  | 'BURN_PENDING'
  | 'BURN_CONFIRMED'
  | 'ATTESTATION_PENDING'
  | 'ATTESTATION_CONFIRMED'
  | 'MINT_PENDING'
  | 'MINT_CONFIRMED'
  | 'VERIFIED'
  | 'FAILED';

export interface BridgeStageLogEntry {
  stage: BridgeStage;
  txHash?: string;
  chainId?: number;
  errorDetail?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record a stage transition. Fire-and-forget: errors are caught and logged
 * to console but never propagated to the caller (the bridge must proceed
 * even if logging fails).
 */
export async function logBridgeStage(
  intentId: string,
  entry: BridgeStageLogEntry,
): Promise<void> {
  try {
    await (prisma as any).bridgeAttemptStage.create({
      data: {
        intentId,
        stage: entry.stage,
        txHash: entry.txHash ?? null,
        chainId: entry.chainId ?? null,
        errorDetail: entry.errorDetail ?? null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      },
    });
    console.log(
      `[bridge-stage] ${intentId} → ${entry.stage}` +
        (entry.txHash ? ` tx=${entry.txHash}` : '') +
        (entry.chainId ? ` chain=${entry.chainId}` : '') +
        (entry.errorDetail ? ` error=${entry.errorDetail}` : ''),
    );
  } catch (err) {
    console.error('[bridge-stage] failed to log stage:', intentId, entry.stage, err);
  }
}

/**
 * Fetch the full stage history for an intent, ordered by time.
 */
export async function getBridgeStageHistory(intentId: string) {
  try {
    return await (prisma as any).bridgeAttemptStage.findMany({
      where: { intentId },
      orderBy: { createdAt: 'asc' },
    });
  } catch {
    return [];
  }
}

/**
 * Fetch the latest stage for an intent (the "current" stage).
 */
export async function getBridgeCurrentStage(intentId: string) {
  try {
    const rows = await (prisma as any).bridgeAttemptStage.findMany({
      where: { intentId },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    return rows[0] ?? null;
  } catch {
    return null;
  }
}
