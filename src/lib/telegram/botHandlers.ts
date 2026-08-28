/**
 * botHandlers.ts
 *
 * Command logic for the Telegram bot. Wallet address is never shown to
 * the user until they explicitly request withdrawal — everything else
 * (apply, deliver, check balance in USD terms) works without ever
 * surfacing an address, per the original product intent.
 *
 * This file does NOT call the Telegram API directly for sending messages
 * — it returns plain { text, ... } objects. The webhook route (below)
 * owns actual message-sending, keeping this file testable without a live
 * bot connection.
 *
 * Wiring notes (what each handler actually calls):
 *  - /apply  → submitApplication() from src/lib/jobs/applicantScoring.ts
 *  - /deliver → the same flow as src/app/api/jobs/submit/route.ts:
 *    job lookup, Circle getWallet → providerSCA match, then
 *    verifyCallerControlsAddress() + createContractTransaction() from
 *    src/lib/circle/client.ts. The route's own auth wrapper
 *    (withApiKeyOrMerchant) does not admit consumer sessions, so the
 *    bot performs the route's exact inner steps with a consumer_token
 *    cookie instead (see report).
 *  - /balance → getUsdcBalance() from src/lib/wallet/usdcBalance.ts
 *    (same logic as /api/consumer/balance).
 *  - /withdraw → two-step: /withdraw stores a DB-backed intent
 *    (TelegramWithdrawalIntent, 15-minute TTL), /confirm executes via
 *    transferUsdc() from src/lib/circle/transfers.ts (the settlement
 *    Path B transfer pattern). A withdrawal NEVER executes on the first
 *    message.
 */

import { authenticateOrCreateTelegramConsumer, getTelegramConsumerSession } from '@/lib/telegram/telegramAuth';
import { retryGasSponsorship } from '@/lib/wallet/circleWalletProvisioning';
import { prisma } from '@/lib/prisma';
import { getUsdcBalance } from '@/lib/wallet/usdcBalance';
import { transferUsdc } from '@/lib/circle/transfers';
import { issueConsumerSessionToken } from '@/src/lib/auth/consumerSession';
import { NextRequest } from 'next/server';
import { formatUnits } from 'viem';

export interface BotReply {
  text: string;
  parseMode?: 'Markdown' | 'HTML';
}

const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;
const WITHDRAWAL_TTL_MS = 15 * 60 * 1000;

/**
 * /start — first contact. Creates the account + wallet if new, greets
 * back if returning. Never mentions "wallet" or shows an address.
 */
export async function handleStart(telegramUserId: string, displayName: string): Promise<BotReply> {
  const auth = await authenticateOrCreateTelegramConsumer(telegramUserId, displayName);

  if (auth.isNewAccount) {
    return {
      text:
        `Welcome, ${displayName}! You're all set up.\n\n` +
        `You can now apply to jobs, deliver work, and get paid — no setup needed.\n\n` +
        `Type /jobs to see what's available, or /help for all commands.`,
    };
  }

  return {
    text: `Welcome back, ${displayName}. Type /jobs to browse open work, or /help for commands.`,
  };
}

/**
 * /apply <jobId> <pitch text> — wraps the existing applicant scoring
 * submission from batch 6 (submitApplication). Does not reimplement
 * scoring/ranking — reuses it directly.
 */
export async function handleApply(
  telegramUserId: string,
  jobId: string,
  pitchText: string
): Promise<BotReply> {
  const session = await getTelegramConsumerSession(telegramUserId);
  if (!session) {
    return { text: `You need to /start first before applying to jobs.` };
  }

  const { submitApplication } = await import('@/lib/jobs/applicantScoring');

  try {
    await submitApplication({
      jobId,
      applicantAddress: session.walletAddress,
      pitch: pitchText,
    });
    return { text: `Application submitted for job ${jobId}. You'll be notified if you're selected.` };
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('already applied')) {
      return { text: `You've already applied to this job.` };
    }
    return { text: `Couldn't submit your application: ${message}` };
  }
}

/**
 * /jobs — lists open jobs. The real jobs model is Erc8183Job (DB status
 * values are uppercase: 'OPEN', 'FUNDED', 'SUBMITTED', 'COMPLETED' —
 * see src/app/api/jobs/create/route.ts), not the assumed "JobListing".
 * Budget is BigInt in micro-USDC, formatted like the rest of the code.
 */
export async function handleListJobs(): Promise<BotReply> {
  const jobs = await prisma.erc8183Job.findMany({
    where: { status: 'OPEN' },
    take: 10,
    orderBy: { createdAt: 'desc' },
  });

  if (jobs.length === 0) {
    return { text: `No open jobs right now. Check back soon.` };
  }

  const lines = jobs.map((j) => `• *${j.description}* — ${formatUnits(j.budget, 6)} USDC\n  /apply ${j.jobId.toString()} <your pitch>`);
  return { text: `Open jobs:\n\n${lines.join('\n\n')}`, parseMode: 'Markdown' };
}

/**
 * /deliver <jobId> <submission text/link> — calls the REAL jobs/submit
 * route (src/app/api/jobs/submit/route.ts) through its auth wrapper
 * (withApiKeyOrAnySession, which admits consumer_token sessions) with a
 * consumer_token cookie. No bypass, no reimplementation of the route's
 * internals: job lookup, providerSCA match, verifyCallerControlsAddress
 * and the Circle submit tx all happen inside the route itself.
 */
export async function handleDeliver(
  telegramUserId: string,
  jobId: string,
  submissionText: string
): Promise<BotReply> {
  const session = await getTelegramConsumerSession(telegramUserId);
  if (!session) {
    return { text: `You need to /start first.` };
  }

  try {
    const account = await prisma.consumerAccount.findUnique({ where: { walletAddress: session.walletAddress } });
    if (!account?.circleWalletId) {
      return { text: `Your account has no Circle wallet to sign the submission.` };
    }

    const { POST } = await import('@/app/api/jobs/submit/route');
    const token = await issueConsumerSessionToken(account.id, account.walletAddress);
    const request = new NextRequest('http://internal/api/jobs/submit', {
      method: 'POST',
      headers: { cookie: `consumer_token=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        providerWalletId: account.circleWalletId,
        deliverableData: submissionText,
      }),
    });

    const res = await POST(request);
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { text: `Couldn't submit deliverable: ${data.error ?? res.status}` };
    }
    return {
      text:
        `Deliverable submitted for job ${jobId}.\n` +
        `Tx: https://testnet.arcscan.app/tx/${data.txHash}\n` +
        `Awaiting client completion.`,
    };
  } catch (err) {
    return { text: `Couldn't submit deliverable: ${(err as Error).message}` };
  }
}

/**
 * /balance — shows the USDC balance, never the raw wallet address.
 * Reuses the same on-chain lookup as the consumer dashboard's
 * /api/consumer/balance route (getUsdcBalance).
 */
export async function handleBalance(telegramUserId: string): Promise<BotReply> {
  const session = await getTelegramConsumerSession(telegramUserId);
  if (!session) {
    return { text: `You need to /start first.` };
  }
  try {
    const balance = await getUsdcBalance(session.walletAddress);
    return { text: `Your balance: $${balance.toFixed(2)} USDC` };
  } catch {
    return { text: `Couldn't fetch your balance right now. Try again shortly.` };
  }
}

/**
 * /withdraw <destination address> [amount] — the ONLY command that ever
 * surfaces or asks about a wallet address, per the original product
 * intent ("the word wallet never comes up until you withdraw").
 *
 * CONFIRMATION STEP (deliberate): the first /withdraw only STORES a
 * DB-backed intent (TelegramWithdrawalIntent, 15-minute TTL). Nothing
 * moves until the user sends /confirm — a single stray message can
 * never move funds. /cancel clears the intent.
 */
export async function handleWithdraw(
  telegramUserId: string,
  destinationAddress: string,
  amount?: string
): Promise<BotReply> {
  const session = await getTelegramConsumerSession(telegramUserId);
  if (!session) {
    return { text: `You need to /start first.` };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(destinationAddress)) {
    return { text: `That doesn't look like a valid wallet address. Please double-check and try again.` };
  }

  let amountValue = 'ALL';
  if (amount !== undefined && amount !== '') {
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
      return { text: `Invalid amount. Use a positive number with up to 6 decimals, e.g. /withdraw 0x… 5.5` };
    }
    amountValue = amount;
  }

  await prisma.telegramWithdrawalIntent.upsert({
    where: { telegramUserId },
    create: { telegramUserId, destinationAddress, amount: amountValue },
    update: { destinationAddress, amount: amountValue, createdAt: new Date() },
  });

  const amountText = amountValue === 'ALL' ? 'your full balance' : `${amountValue} USDC`;
  return {
    text:
      `Withdrawal requested: ${amountText} → \`${destinationAddress}\`.\n\n` +
      `To execute it, send /confirm within 15 minutes. /cancel aborts.`,
    parseMode: 'Markdown',
  };
}

/**
 * /confirm — executes a previously stored withdrawal intent (see
 * handleWithdraw). The transfer itself reuses the settlement engine's
 * transfer pattern (transferUsdc in src/lib/circle/transfers.ts).
 *
 * DOUBLE-WITHDRAWAL PROTECTION (H6): Telegram retries undelivered webhook
 * POSTs with the SAME update_id, so /confirm can arrive twice. The intent
 * row is claimed ATOMICALLY first (status PENDING → EXECUTING via a
 * conditional updateMany — exactly one /confirm wins the claim), the
 * transfer carries a deterministic Circle idempotency key derived from the
 * intent, and the intent is deleted only after the transfer confirms.
 * A retry during an in-flight transfer gets "already processing" instead
 * of a second transfer; a failed transfer rolls the intent back to
 * PENDING so the user can retry.
 */
export async function handleConfirmWithdraw(telegramUserId: string): Promise<BotReply> {
  const intent = await prisma.telegramWithdrawalIntent.findUnique({ where: { telegramUserId } });
  if (!intent) {
    return { text: `No pending withdrawal. Start one with /withdraw <address> [amount].` };
  }

  if (Date.now() - intent.createdAt.getTime() > WITHDRAWAL_TTL_MS) {
    await prisma.telegramWithdrawalIntent.delete({ where: { telegramUserId } });
    return { text: `That withdrawal request expired. Send /withdraw <address> [amount] to start a new one.` };
  }

  // Atomic claim: exactly one /confirm (or webhook retry) may execute the
  // transfer. A claim failure means another attempt is in flight.
  const claim = await prisma.telegramWithdrawalIntent.updateMany({
    where: { telegramUserId, status: 'PENDING' },
    data: { status: 'EXECUTING' },
  });
  if (claim.count === 0) {
    return { text: `That withdrawal is already being processed. It will land on-chain shortly.` };
  }

  const account = await prisma.consumerAccount.findFirst({ where: { telegramUserId } });
  if (!account?.circleWalletId || !account.walletAddress) {
    await prisma.telegramWithdrawalIntent.delete({ where: { telegramUserId } });
    return { text: `Your account has no Circle wallet — withdrawals aren't available for this account.` };
  }

  let amount = intent.amount;
  if (amount === 'ALL') {
    const balance = await getUsdcBalance(account.walletAddress);
    if (balance <= 0) {
      await prisma.telegramWithdrawalIntent.delete({ where: { telegramUserId } });
      return { text: `You have no USDC balance to withdraw.` };
    }
    amount = balance.toFixed(6);
  }

  try {
    const { arcTxHash, circleTxId } = await transferUsdc({
      walletId: account.circleWalletId,
      walletAddress: account.walletAddress,
      destinationAddress: intent.destinationAddress,
      amount,
      idempotencyKey: `telegram-withdraw-${telegramUserId}-${intent.createdAt.getTime()}`,
    });
    await prisma.telegramWithdrawalIntent.delete({ where: { telegramUserId } });
    return {
      text:
        `Withdrawn ${amount} USDC to \`${intent.destinationAddress}\`.\n` +
        `Tx: https://testnet.arcscan.app/tx/${arcTxHash}\n` +
        `(Circle tx ${circleTxId})`,
      parseMode: 'Markdown',
    };
  } catch (err) {
    // Roll the claim back so the user can retry (/confirm again) — only a
    // failure releases the intent; a retry mid-flight never re-transfers.
    await prisma.telegramWithdrawalIntent
      .updateMany({ where: { telegramUserId, status: 'EXECUTING' }, data: { status: 'PENDING' } })
      .catch(() => {});
    return { text: `Withdrawal failed: ${(err as Error).message} — send /confirm again to retry, or /cancel.` };
  }
}

/**
 * /cancel — clears any pending withdrawal intent without moving funds.
 */
export async function handleCancelWithdraw(telegramUserId: string): Promise<BotReply> {
  const deleted = await prisma.telegramWithdrawalIntent.deleteMany({ where: { telegramUserId } });
  return deleted.count > 0
    ? { text: `Withdrawal cancelled. No funds moved.` }
    : { text: `No pending withdrawal to cancel.` };
}

export async function handleHelp(): Promise<BotReply> {
  return {
    text:
      `Commands:\n` +
      `/jobs — see open jobs\n` +
      `/apply <jobId> <pitch> — apply to a job\n` +
      `/deliver <jobId> <link/text> — submit completed work\n` +
      `/balance — check your balance\n` +
      `/withdraw <address> [amount] — withdraw funds to your own wallet\n` +
      `/confirm — execute a pending withdrawal\n` +
      `/cancel — cancel a pending withdrawal\n` +
      `/history — recent completed jobs and lifetime earnings\n` +
      `/retrygas — retry a stuck gas sponsorship`,
  };
}

export async function handleGasRetry(telegramUserId: string): Promise<BotReply> {
  try {
    await retryGasSponsorship(telegramUserId);
    return { text: `Gas sponsorship retried successfully.` };
  } catch (err) {
    return { text: `Couldn't retry gas sponsorship: ${(err as Error).message}` };
  }
}

export async function handleHistory(telegramUserId: string): Promise<BotReply> {
  const session = await getTelegramConsumerSession(telegramUserId);
  if (!session) {
    return { text: `You need to /start first.` };
  }
  try {
    const jobs = await prisma.erc8183Job.findMany({
      where: { providerSCA: { equals: session.walletAddress, mode: "insensitive" as any }, status: "COMPLETED" },
      take: 10,
      orderBy: { updatedAt: "desc" },
    } as any);
    if (jobs.length === 0) {
      return { text: `No completed jobs yet. Apply with /apply and deliver with /deliver to get started.` };
    }
    let total = 0n;
    for (const j of jobs as any[]) {
      try { total += BigInt(j.budget); } catch {}
    }
    const lines = (jobs as any[]).map((j) => {
      const amt = formatUnits(BigInt(j.budget), 6);
      const desc = (j.description || "").slice(0, 40);
      return `• Job #${j.jobId.toString()} — ${amt} USDC — ${desc}`;
    });
    const totalStr = formatUnits(total, 6);
    return {
      text: `Recent completions (${jobs.length}):\n${lines.join("\n")}\n\nLifetime earnings (recent 10): ${totalStr} USDC`,
    };
  } catch (err) {
    return { text: `Couldn't fetch history: ${(err as Error).message}` };
  }
}