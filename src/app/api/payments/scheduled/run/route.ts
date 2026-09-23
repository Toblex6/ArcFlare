import { NextResponse } from 'next/server';
import { checkRateLimit } from '@/src/lib/ratelimit';
import { prisma } from '@/lib/prisma';
import { withApiKey } from '@/lib/middleware/withApiKey';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { resolveRowCurrency } from '@/lib/tokens/resolveCurrency';
import { explorerTxUrl, getNetworkConfig } from "@/lib/config/network";
import { resolveConsumerWallet } from "@/src/lib/auth/consumerWallet";
import { enforceSpendLimit } from '@/lib/agents/spendWindow';
import { parseUnits } from 'viem';
import {
  executeTrackedTransfer,
  prismaTrackedTransferStore,
  TransferInProgressError,
} from '@/src/lib/payments/trackedTransfer';
import {
  computeScheduleAdvance,
  scheduledPeriodKey,
  scheduledPeriodReference,
} from '@/src/lib/payments/scheduledExecution';

function getCircleClient() {
  return initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY!,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
  });
}

// ── Pure derivation for one scheduled execution (no state change, no Circle
// call): resolved payer wallet, canonical token, formatted amount. Throws
// fail-closed before any claim row or transfer exists.
function deriveScheduledTransfer(scheduled: any) {
  // FAIL CLOSED — no shared-default fallback, ever. (See original comment
  // preserved on assertScheduledPayerBinding below.)
  if (!scheduled.payerWalletId) {
    throw new Error(
      `Scheduled payment ${scheduled.reference} has no resolved payer wallet (payerWalletId is null) — refusing to execute against a shared default.`
    );
  }
  // Phase 2C: resolve THIS row's canonical token — the transfer moves exactly
  // this token. Historical rows with NULL tokenAddress resolve to USDC, so
  // legacy schedules execute byte-identically.
  let token;
  try {
    token = resolveRowCurrency(scheduled);
  } catch (tokenError: any) {
    throw new Error(
      `Scheduled payment ${scheduled.reference} has an unresolvable token (currency=${scheduled.currency ?? 'null'} tokenAddress=${scheduled.tokenAddress ?? 'null'}): ${tokenError.message} — refusing to execute.`
    );
  }
  const walletId: string = scheduled.payerWalletId;
  // Decimals come from the canonical resolver — never assumed.
  const amountStr = scheduled.amount.toFixed(token.decimals);
  return { token, amountStr, walletId };
}

// Consumer binding revalidation at CREATION time: the stored payerWalletId
// must still be exactly the signing identity the payer's CURRENT
// ConsumerAccount row binds (CIRCLE + bound). Runs inside `beforeCreate`, so
// it gates every fresh transfer but never blocks resuming an already-created
// one (refusing to poll cannot un-send; only completing is safe).
async function assertScheduledPayerBinding(scheduled: any, walletId: string) {
  const payerAccount = await (prisma as any).consumerAccount
    .findUnique({ where: { walletAddress: scheduled.payerSCA } })
    .catch(() => null);
  if (payerAccount) {
    const wallet = resolveConsumerWallet(payerAccount);
    if (!wallet || wallet.mode !== 'CIRCLE' || !wallet.canServerSign) {
      throw new Error(
        `Scheduled payment ${scheduled.reference} payer ${scheduled.payerSCA} is not a server-signable CIRCLE wallet — refusing to execute.`
      );
    }
    if (wallet.circleWalletId !== walletId) {
      throw new Error(
        `Scheduled payment ${scheduled.reference} payer wallet binding changed since creation — refusing to execute against a stale wallet id.`
      );
    }
  }
}

// ── Crash-safe execution of ONE scheduled period (P1-2) ────────────────────
// ONE scheduled execution period produces AT MOST ONE Circle transfer.
// The PaymentLog row keyed by scheduledPeriodKey(id, runCount) is the claim:
// the Circle transaction ID is persisted to it as soon as creation returns,
// so a crash before normal completion is recovered by RESUMING the tracked
// transfer — never by creating a second one. A FAILED tracked transfer is
// terminal (discarded, fresh creation allowed — settle parity); anything else
// keeps its ID for resume. See trackedTransfer.ts for the full contract.
async function executeScheduledPeriod(
  scheduled: any,
  circleClient: ReturnType<typeof getCircleClient>,
  now: Date
) {
  const prep = deriveScheduledTransfer(scheduled);
  const { token, amountStr, walletId } = prep;
  const store = prismaTrackedTransferStore((prisma as any).paymentLog);

  const exec = await executeTrackedTransfer({
    store,
    circle: circleClient as any,
    idempotencyKey: scheduledPeriodKey({ id: scheduled.id, runCount: scheduled.runCount }),
    claimData: {
      // PaymentLog is the source of truth for whether this period's money
      // moved (circleTxId/arcTxHash live here); the schedule row below is
      // advanced only on confirmation.
      reference: scheduledPeriodReference({ reference: scheduled.reference, runCount: scheduled.runCount }),
      amount: scheduled.amount,
      currency: token.symbol,
      tokenAddress: token.address,
      chain: getNetworkConfig().circleBlockchain,
      senderEmail: 'scheduled-payment-system',
      merchant: scheduled.receiverSCA,
      agentSCA: scheduled.payerSCA,
      payerSCA: scheduled.payerSCA,
    },
    // Creation-time gates (never run on resume — the spend was recorded when
    // the tracked transfer was created; re-running them cannot un-send).
    beforeCreate: async () => {
      await assertScheduledPayerBinding(scheduled, walletId);
      // ── Spend-limit gate (audit: spend-limit gap) — BEFORE the transfer
      // executes. Every scheduled debit composes the on-chain
      // ArcFlareSpendLimit pre-flight with the atomic per-payer DB window, so
      // a burst of due rows (or concurrent runners) can never jointly exceed
      // the payer's cap.
      const amountMicros = parseUnits(amountStr, token.decimals);
      const spendGate = await enforceSpendLimit({
        payerAddress: scheduled.payerSCA,
        amountMicros,
        context: `scheduled/run:${scheduled.reference}`,
      });
      if (!spendGate.allowed) {
        throw new Error(
          `Scheduled payment ${scheduled.reference} blocked by spend limit: ${spendGate.reason} — no funds moved.`
        );
      }
    },
    createNative: () =>
      circleClient.createTransaction({
        walletId,
        blockchain: getNetworkConfig().circleBlockchain as any,
        tokenAddress: token.address,
        destinationAddress: scheduled.receiverSCA,
        amounts: [amountStr],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      } as any),
    createFallback: async () => {
      const amountWei = parseUnits(amountStr, token.decimals);
      return circleClient.createContractExecutionTransaction({
        walletAddress: scheduled.payerSCA,
        blockchain: getNetworkConfig().circleBlockchain as any,
        contractAddress: token.address,
        abiFunctionSignature: 'transfer(address,uint256)',
        abiParameters: [scheduled.receiverSCA, amountWei.toString()],
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      });
    },
    // Idempotent completion: advances the schedule ONLY if this attempt still
    // holds the PROCESSING claim at the expected runCount. A retry after a
    // crash between advancement and the SUCCESS mark finds count 0 and
    // proceeds — exactly one advancement per period, ever.
    onConfirmed: async () => {
      const adv = computeScheduleAdvance(
        {
          runCount: scheduled.runCount,
          maxRuns: scheduled.maxRuns,
          intervalDays: scheduled.intervalDays,
        },
        now
      );
      await (prisma as any).scheduledPayment.updateMany({
        where: { id: scheduled.id, status: 'PROCESSING', runCount: scheduled.runCount },
        data: {
          lastRunAt: now,
          runCount: adv.newRunCount,
          nextRunAt: adv.nextRunAt,
          status: adv.isComplete ? 'COMPLETED' : 'ACTIVE',
        },
      });
    },
  });

  return {
    txHash: exec.txHash,
    currency: token.symbol,
    tokenAddress: token.address,
    resumed: exec.resumed,
    replayed: exec.replayed,
  };
}

// ── POST /api/payments/scheduled/run ──────────────────────────────────────────
//
// DOUBLE-PAYMENT PROTECTION (H7 + P1-2): two concurrent /run calls (or a retry
// while one is still executing) must never both pay the same scheduled row,
// and a crash between transfer creation and completion must never produce a
// second transfer on recovery.
//   Layer 1 — per-row ATOMIC claim: status ACTIVE → PROCESSING via a
//   conditional updateMany keyed on id + status. Only the runner whose claim
//   succeeded processes the row; a concurrent runner sees 0 claimed rows and
//   skips them. A row left PROCESSING by a crashed runner is reclaimed after
//   STALE_CLAIM_MS (lastRunAt is stamped at claim time, so a crashed run
//   can't block the row forever).
//   Layer 2 — per-PERIOD tracked transfer (executeScheduledPeriod): the
//   PaymentLog row keyed by (schedule id, runCount) carries the Circle
//   transaction ID from creation to finality. Stale recovery RESUMES that
//   transfer instead of creating another — one period, at most one transfer.
const STALE_CLAIM_MS = 5 * 60 * 1000;

async function runScheduledHandler(request: Request) {
  try {
    // H9: payments-tier rate limit on this fund-moving POST (fail-closed:
    // memory fallback still enforces when Upstash is unreachable).
    const { allowed, response: limitResponse } = await checkRateLimit(request as any, 'payments');
    if (!allowed) return limitResponse!;
    const now = new Date();

    const candidates = await (prisma as any).scheduledPayment.findMany({
      where: {
        nextRunAt: { lte: now },
        OR: [
          { status: 'ACTIVE' },
          // Stale PROCESSING rows (left behind by a crashed runner) are
          // reclaimable; fresh PROCESSING rows belong to a live runner.
          { status: 'PROCESSING', lastRunAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) } },
        ],
      },
    });

    console.log(`⏰ Found ${candidates.length} due scheduled payment(s)`);

    if (candidates.length === 0) {
      return NextResponse.json({
        success: true,
        checkedAt: now.toISOString(),
        dueCount: 0,
        executedCount: 0,
        failedCount: 0,
        results: [],
      });
    }

    const circleClient = getCircleClient();
    const results: any[] = [];
    let executedCount = 0;
    let failedCount = 0;

    for (const scheduled of candidates) {
      // Per-row ATOMIC claim. Exactly one runner can flip this row into
      // PROCESSING; a concurrent runner's updateMany matches 0 rows and
      // skips it — no double payment. Stale PROCESSING rows are only
      // reclaimable if their claim stamp is old enough (crash recovery).
      const claim = await (prisma as any).scheduledPayment.updateMany({
        where: {
          id: scheduled.id,
          status: scheduled.status,
          ...(scheduled.status === 'PROCESSING' ? { lastRunAt: { lte: new Date(now.getTime() - STALE_CLAIM_MS) } } : {}),
        },
        data: { status: 'PROCESSING', lastRunAt: now },
      });

      if (claim.count === 0) {
        results.push({
          reference: scheduled.reference,
          success: false,
          error: 'skipped — already claimed by another runner',
        });
        continue;
      }

      try {
        // Crash-safe: the schedule row is advanced inside onConfirmed (only
        // on a confirmed transfer, exactly once per period); the PaymentLog
        // period row proves whether this period's money moved.
        const execution = await executeScheduledPeriod(scheduled, circleClient, now);
        const { txHash } = execution;

        const adv = computeScheduleAdvance(
          {
            runCount: scheduled.runCount,
            maxRuns: scheduled.maxRuns,
            intervalDays: scheduled.intervalDays,
          },
          now
        );

        if (scheduled.webhookUrl) {
          fetch(scheduled.webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              event: 'scheduled_payment.executed',
              reference: scheduled.reference,
              amount: scheduled.amount,
              currency: execution.currency,
              tokenAddress: execution.tokenAddress,
              txHash,
              explorerUrl: `${explorerTxUrl(txHash)}`,
              runCount: adv.newRunCount,
              nextRunAt: adv.isComplete ? null : adv.nextRunAt,
              resumed: execution.resumed,
              replayed: execution.replayed,
            }),
          }).catch(() => {});
        }

        results.push({
          reference: scheduled.reference,
          success: true,
          txHash,
          explorerUrl: `${explorerTxUrl(txHash)}`,
          currency: execution.currency,
          tokenAddress: execution.tokenAddress,
          resumed: execution.resumed,
          replayed: execution.replayed,
        });
        executedCount++;
        console.log(`✅ Executed scheduled payment ${scheduled.reference} (${execution.currency}): ${txHash}`);
      } catch (err: any) {
        // Another flight owns this period's claim row (fresh PROCESSING, no
        // tracked transfer yet): leave its claim alone — releasing it here
        // could hand a live execution to a third runner.
        if (err instanceof TransferInProgressError || err?.name === 'TransferInProgressError') {
          console.log(`⏭️ Skipped scheduled payment ${scheduled.reference}: period claim held by another flight`);
          results.push({
            reference: scheduled.reference,
            success: false,
            error: 'skipped — period already being processed (idempotent claim held)',
          });
          continue;
        }
        // Release the claim back to ACTIVE so the failure is retried on the
        // next tick. Safe under P1-2: a persisted Circle transaction ID is
        // resumed, never duplicated; a FAILED preflight/creation left no
        // transfer behind, so the retry creates exactly one.
        await (prisma as any).scheduledPayment
          .updateMany({
            where: { id: scheduled.id, status: 'PROCESSING' },
            data: { status: 'ACTIVE' },
          })
          .catch(() => {});
        console.error(`❌ Failed scheduled payment ${scheduled.reference}:`, err.message);
        results.push({
          reference: scheduled.reference,
          success: false,
          error: err.message,
        });
        failedCount++;
      }
    }

    return NextResponse.json({
      success: true,
      checkedAt: now.toISOString(),
      dueCount: candidates.length,
      executedCount,
      failedCount,
      results,
    });
  } catch (error: any) {
    console.error('❌ Scheduled run error:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}

export const POST = withApiKey(runScheduledHandler);
