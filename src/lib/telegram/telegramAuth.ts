/**
 * telegramAuth.ts
 *
 * Maps a Telegram user to a consumer_token account — confirmed decision:
 * Telegram users are consumer_token accounts, same JWT system as web
 * consumers, not a new/separate auth boundary.
 *
 * Token issuance is NOT reimplemented here: it calls
 * issueConsumerSessionToken() from src/lib/auth/consumerSession.ts — the
 * exact same function the web consumer login flow
 * (src/app/api/consumer/session/route.ts) uses, which enforces the
 * fail-closed CONSUMER_JWT_SECRET requirement.
 */

import { prisma } from '@/lib/prisma';
import { issueConsumerSessionToken } from '@/src/lib/auth/consumerSession';
import { provisionWalletForTelegramUser } from '@/lib/wallet/circleWalletProvisioning';

export interface TelegramAuthResult {
  consumerToken: string;
  consumerId: string;
  walletAddress: string;
  isNewAccount: boolean;
}

/**
 * Call this on every /start (or first message from an unrecognized
 * Telegram user). Idempotent — returns the existing account/token if one
 * already exists, only provisions a new wallet + account on first
 * contact.
 */
export async function authenticateOrCreateTelegramConsumer(
  telegramUserId: string,
  displayName: string
): Promise<TelegramAuthResult> {
  const existing = await prisma.consumerAccount.findFirst({ where: { telegramUserId } });

  if (existing) {
    const consumerToken = await issueConsumerToken(existing.id, existing.walletAddress);
    return {
      consumerToken,
      consumerId: existing.id,
      walletAddress: existing.walletAddress!,
      isNewAccount: false,
    };
  }

  // provisionWalletForTelegramUser is itself idempotent (checks + upserts
  // by telegramUserId), so no race-condition risk between this check and
  // that call beyond what it already guards against internally.
  const wallet = await provisionWalletForTelegramUser(telegramUserId, displayName);

  const account = await prisma.consumerAccount.findFirst({ where: { telegramUserId } });
  if (!account) {
    // Should be unreachable — provisionWalletForTelegramUser upserts the
    // row itself. Throwing loudly rather than silently proceeding with a
    // null account, since this would indicate a real bug in the
    // provisioning flow, not a normal edge case.
    throw new Error(`consumer account not found immediately after provisioning for telegram user ${telegramUserId} — investigate provisionWalletForTelegramUser`);
  }

  const consumerToken = await issueConsumerToken(account.id, account.walletAddress);

  return {
    consumerToken,
    consumerId: account.id,
    walletAddress: wallet.walletAddress,
    isNewAccount: true,
  };
}

/**
 * Issues the consumer_token JWT for a Telegram consumer — wired to the
 * web consumer login flow's signing function
 * (issueConsumerSessionToken in src/lib/auth/consumerSession.ts, used by
 * src/app/api/consumer/session/route.ts). Fail-closed via
 * requireJwtSecret('CONSUMER_JWT_SECRET').
 */
async function issueConsumerToken(consumerId: string, walletAddress: string): Promise<string> {
  return issueConsumerSessionToken(consumerId, walletAddress);
}

/**
 * Looks up a consumer's session by Telegram user ID, for use in bot
 * command handlers that need to act on behalf of an already-authenticated
 * user without re-running the full auth flow every message.
 */
export async function getTelegramConsumerSession(
  telegramUserId: string
): Promise<{ consumerId: string; walletAddress: string } | null> {
  const account = await prisma.consumerAccount.findFirst({ where: { telegramUserId } });
  if (!account?.walletAddress) return null;
  return { consumerId: account.id, walletAddress: account.walletAddress };
}
