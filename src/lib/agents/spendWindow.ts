// src/lib/agents/spendWindow.ts
//
// Per-payer windowed-sum spend limiter (audit fix: spend-limit gap).
//
// The on-chain ArcFlareSpendLimit cap is only enforced at the 3 call sites
// that already used it; every other value-moving path (payroll/run,
// scheduled/run, nano, nano/settle, stream/create) moved value with NO cap
// at all, and the on-chain cap alone could be raced by concurrent small
// requests (check-then-send between two relayer txs).
//
// This module closes both halves:
//   1. A DB-level ATOMIC windowed sum per payer — the read-check-write runs
//      inside one Serializable transaction that takes a row lock
//      (SELECT … FOR UPDATE), so two concurrent requests can never jointly
//      exceed the cap. This is NOT a JS-side sum-then-write.
//   2. A single composed entry point, enforceSpendLimit(), that routes run
//      pre-flight (on-chain wouldExceedLimit) → window record (this module)
//      in that order, BEFORE the transfer executes — matching the pattern
//      proven at agentPay / payrollExecution / jobs fund.
//
// On-chain enforcement (relayer-signed checkAndRecordSpend) remains the hard
// backstop at call sites that settle on-chain (see ArcFlareSpendLimit.sol,
// recorder-ACL'd); this layer is the app-level atomic gate.

import { prisma } from "@/lib/prisma";
import { checkSpendAllowed } from "@/lib/agents/spendLimitEnforcer";

// Window + default ceiling. The windower's job is race-safety between
// concurrent requests; the absolute ceiling is a backstop so a route that
// forgot its config fails closed instead of unbounded.
export const SPEND_WINDOW_SECONDS = 24 * 60 * 60;

// Per-payer app-level ceiling in 6-dec micros (2,500 USDC / 24h). Merchants
// needing larger flows raise the on-chain cap via /api/agents/[id]/policy;
// this limiter protects the SHARED platform wallets (default payer, relayer,
// seller EOA) which have no per-agent on-chain row.
export const SPEND_WINDOW_CAP_MICROS = 2_500n * 1_000_000n;

export interface SpendLimitGateParams {
  /** Payer wallet (SCA or EOA) the spend debits — lowercased internally. */
  payerAddress: string;
  /** Spend amount in 6-dec canonical base units. */
  amountMicros: bigint;
  /** Label for audit rows (route identity). */
  context: string;
}

export interface SpendLimitGateResult {
  allowed: boolean;
  status: number;
  reason?: string;
  windowSpentMicros?: bigint;
}

function windowExpired(windowStart: Date): boolean {
  return Date.now() - windowStart.getTime() >= SPEND_WINDOW_SECONDS * 1000;
}

/**
 * ATOMIC window record — Serializable transaction + row lock.
 * Returns { ok: true } when the spend fits inside the current window; the
 * row's spentMicros is incremented in the SAME locked transaction, so a
 * concurrent request for the same payer blocks on the row lock until this
 * one commits and then re-evaluates against the UPDATED total.
 */
async function recordSpendInWindowAtomic(
  payer: string,
  amountMicros: bigint
): Promise<{ ok: true; spentMicros: bigint } | { ok: false; spentMicros: bigint }> {
  // The read-check-write must be atomic. FOR UPDATE under READ COMMITTED is
  // the right primitive (not Serializable): a concurrent transaction for the
  // same payer BLOCKS on the row lock, then re-reads the latest committed
  // spentMicros before its own check — so the cap can never be jointly
  // exceeded, while 40001 serialization aborts (which would need retries on
  // every request) are avoided entirely. The retry loop below is the belt-
  // and-braces for the rare abort/unique-race cases (P2034/40001/P2002).
  const MAX_TX_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          // Lock the payer's window row (create-if-missing).
          const existing = await tx.$queryRaw<Array<{ spentMicros: bigint; windowStart: Date }>>`
            SELECT "spentMicros", "windowStart" FROM "spend_windows" WHERE "payerAddress" = ${payer} FOR UPDATE`;

          let spentMicros = 0n;
          let expired = false;

          if (existing.length > 0) {
            spentMicros = BigInt(existing[0].spentMicros);
            expired = windowExpired(existing[0].windowStart);
            if (expired) {
              spentMicros = 0n;
              await tx.$executeRaw`
                UPDATE "spend_windows" SET "spentMicros" = 0, "windowStart" = NOW() WHERE "payerAddress" = ${payer}`;
            }
          } else {
            await tx.$executeRaw`
              INSERT INTO "spend_windows" ("id", "payerAddress", "windowStart", "spentMicros", "updatedAt") VALUES (gen_random_uuid()::text, ${payer}, NOW(), 0, NOW())`;
          }

          if (spentMicros + amountMicros > SPEND_WINDOW_CAP_MICROS) {
            return { ok: false as const, spentMicros };
          }

          const newTotal = spentMicros + amountMicros;
          await tx.$executeRaw`
            UPDATE "spend_windows" SET "spentMicros" = ${newTotal} WHERE "payerAddress" = ${payer}`;
          return { ok: true as const, spentMicros: newTotal };
        },
        // Lock waiters queue behind earlier transactions for the same payer —
        // under heavy concurrency a waiter can hold past the 5s default, so
        // the timeout is raised explicitly (the tx still only does 2-3 fast
        // queries once the lock is acquired).
        { isolationLevel: "ReadCommitted", timeout: 30_000, maxWait: 15_000 }
      );
    } catch (e: any) {
      const code = e?.code ?? e?.meta?.code;
      const retriable =
        code === 'P2034' || // Prisma: transaction conflict / serialization failure
        e?.meta?.code === '40001' || // PG: could not serialize access
        code === 'P2002' || // unique-violation race on first insert — row now exists, retry reads it
        code === 'P2028'; // transaction expired while lock-waiting — rolled back, safe to retry
      if (!retriable || attempt >= MAX_TX_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 90)));
    }
  }
}

/**
 * Composed gate for every value-moving path. Call BEFORE the transfer:
 *   1. on-chain pre-flight (wouldExceedLimit — view, no state change)
 *   2. atomic DB window record (this module — row-locked, race-free)
 * A false result means NO funds have moved; the caller returns the given
 * status/reason. Call sites that settle on-chain afterwards still run the
 * recorder-ACL'd checkAndRecordSpend as the hard backstop.
 */
export async function enforceSpendLimit(
  params: SpendLimitGateParams
): Promise<SpendLimitGateResult> {
  const payer = params.payerAddress.toLowerCase();

  // 1. On-chain pre-flight. If the contract has no limit configured for this
  //    payer (or the RPC is down), the DB window below still bounds it —
  //    the composition is fail-closed in aggregate, never "chain-down = uncapped".
  try {
    const spendCheck = await checkSpendAllowed({
      agentAddress: params.payerAddress,
      amount: params.amountMicros,
    });
    if (!spendCheck.allowed) {
      return {
        allowed: false,
        status: 403,
        reason: `spend limit rejected: ${spendCheck.reason}`,
      };
    }
  } catch (e: any) {
    console.error(
      `[spendWindow] on-chain pre-flight unavailable for ${payer.slice(0, 10)}… (${e?.message ?? e}) — DB window still enforces.`
    );
  }

  // 2. Atomic per-payer window record.
  const recorded = await recordSpendInWindowAtomic(payer, params.amountMicros);
  if (!recorded.ok) {
    return {
      allowed: false,
      status: 403,
      reason: `per-payer spend window cap would be exceeded (spent ${(Number(recorded.spentMicros) / 1e6).toFixed(6)} of ${(Number(SPEND_WINDOW_CAP_MICROS) / 1e6).toFixed(0)} USDC in the ${SPEND_WINDOW_SECONDS / 3600}h window)`,
      windowSpentMicros: recorded.spentMicros,
    };
  }

  return { allowed: true, status: 200, windowSpentMicros: recorded.spentMicros };
}


