// src/lib/payments/scheduledExecution.ts
//
// Per-period identity + advancement math for scheduled payments (P1-2).
//
// ONE scheduled execution period MUST produce AT MOST ONE Circle transfer.
// The period is identified by (schedule id, runCount): runCount only advances
// on a confirmed execution, so the key is stable across crash-recovery and
// concurrent-worker races — both resolve to the SAME PaymentLog claim row,
// and the tracked-transfer executor (trackedTransfer.ts) resumes the tracked
// Circle transaction instead of creating a second one.
//
// Pure module (no prisma/Circle imports): the route uses these helpers and
// scripts/scheduled-resume-tests.ts exercises the real functions.

/** Stable idempotency key for one scheduled execution period. */
export function scheduledPeriodKey(s: { id: string; runCount: number }): string {
  return `scheduled-run:${s.id}:${s.runCount}`;
}

/** Unique PaymentLog reference for one scheduled execution period. */
export function scheduledPeriodReference(s: { reference: string; runCount: number }): string {
  return `scheduled_${s.reference}_run_${s.runCount}`;
}

export interface ScheduleAdvance {
  newRunCount: number;
  isComplete: boolean;
  nextRunAt: Date;
  status: string;
}

/**
 * Advance math for a confirmed execution. Byte-identical semantics to the
 * pre-P1-2 runner: runCount+1, COMPLETED once maxRuns is reached, otherwise
 * ACTIVE with nextRunAt one interval ahead.
 */
export function computeScheduleAdvance(
  s: { runCount: number; maxRuns: number | null | undefined; intervalDays: number },
  now: Date
): ScheduleAdvance {
  const newRunCount = s.runCount + 1;
  const isComplete = !!(s.maxRuns && newRunCount >= s.maxRuns);
  return {
    newRunCount,
    isComplete,
    nextRunAt: new Date(now.getTime() + s.intervalDays * 24 * 60 * 60 * 1000),
    status: isComplete ? 'COMPLETED' : 'ACTIVE',
  };
}
