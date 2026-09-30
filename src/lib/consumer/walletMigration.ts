// src/lib/consumer/walletMigration.ts
//
// Consumer mainnet wallet upgrade (Step C) — login-time, consumers only.
//
// Rule: a new wallet is provisioned ONLY when Circle's getWallet returns a
// CLEAN 404 for the stored circleWalletId (test-era wallet invisible to the
// production key). Any other lookup error (network, timeout, 5xx, malformed
// id) creates NOTHING and surfaces "try again".
//
// Concurrency: two simultaneous logins for the same account cannot mint two
// wallets — a per-account pg advisory lock + SELECT … FOR UPDATE serializes
// same-account migrations inside one transaction (re-check after lock), and
// both Circle creates carry STABLE per-account idempotency keys so a retried
// request replays Circle-side instead of minting again.
//
// Scope: ConsumerAccount CIRCLE rows on mainnet ONLY. Merchants,
// AgentRegistry, EXTERNAL/legacy rows, and non-mainnet networks are never
// touched here (merchants/agents come later — address changes there affect
// payment links and payouts). No bulk path exists: the single entry point
// takes one accountId and runs on that account's own login.
//
// History: the replaced { walletId, walletAddress, migratedAt, reason } is
// appended to previousWallets — nothing is ever deleted or rewritten.

import { prisma } from "@/src/lib/prisma";
import { getCircleClient } from "@/src/lib/circle/client";
import { getNetworkConfig } from "@/src/lib/config/network";
import { ConsumerFeatureError } from "@/src/lib/auth/consumerWallet";
import {
  WALLET_CHECK_RETRY_MESSAGE,
  WALLET_UPGRADED_MESSAGE,
  isCircleClean404,
  migrationIdempotencyKey as sharedMigrationKey,
} from "@/src/lib/wallets/upgradeGuards";

// Re-exported for existing importers (single authority lives in
// upgradeGuards.ts).
export { isCircleClean404 };
export { WALLET_CHECK_RETRY_MESSAGE, WALLET_UPGRADED_MESSAGE };

/** Friendly Send-time signal when the stored wallet is gone server-side. */
export const WALLET_NEEDS_UPDATE_MESSAGE = "Your wallet needs updating, please log in again.";

/** Stable per-account Circle idempotency key (consumer namespace). */
export function migrationIdempotencyKey(accountId: string, purpose: "set" | "wallets"): string {
  return sharedMigrationKey("consumer", accountId, purpose);
}

export interface MigrationOutcome {
  migrated: boolean;
  /** New wallet address (post-migration row) or current address. */
  walletAddress: string;
  /** New circleWalletId (post-migration row) or current id. */
  circleWalletId: string | null;
  /** True when the one-time upgrade message is still owed. */
  noticePending: boolean;
}

function advisoryLockKey(accountId: string): string {
  return `consumer-wallet-migrate:${accountId}`;
}

/**
 * Login-time upgrade check for ONE consumer account. Creates a wallet only
 * on a clean 404 (see isCircleClean404); every other failure throws a typed
 * try-again error and creates nothing. Never touches merchants/agents.
 */
export async function ensureMainnetConsumerWallet(accountId: string): Promise<MigrationOutcome> {
  const account = await (prisma as any).consumerAccount
    .findUnique({ where: { id: accountId } })
    .catch(() => null);
  if (!account || account.walletType !== "CIRCLE" || !account.circleWalletId) {
    return {
      migrated: false,
      walletAddress: String(account?.walletAddress ?? ""),
      circleWalletId: account?.circleWalletId ?? null,
      noticePending: !!account?.migrationNoticePending,
    };
  }
  // Mainnet only: test wallets stay valid under the test key, and only the
  // mainnet network may mint ARC wallets. Off-mainnet logins never write.
  if (getNetworkConfig().name !== "mainnet") {
    return {
      migrated: false,
      walletAddress: String(account.walletAddress),
      circleWalletId: account.circleWalletId,
      noticePending: !!account.migrationNoticePending,
    };
  }

  const staleId: string = account.circleWalletId;
  const circleClient = getCircleClient();
  try {
    const res: any = await circleClient.getWallet({ id: staleId });
    if (res?.data?.wallet) {
      return {
        migrated: false,
        walletAddress: String(account.walletAddress),
        circleWalletId: staleId,
        noticePending: !!account.migrationNoticePending,
      };
    }
    throw new ConsumerFeatureError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
  } catch (err: any) {
    if (err instanceof ConsumerFeatureError) throw err;
    if (!isCircleClean404(err)) {
      throw new ConsumerFeatureError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
    }
    // Clean 404 → provision under a per-account lock (concurrent logins
    // serialize; the loser re-reads the winner's row below).
    return migrateConsumerWalletLocked(accountId, staleId);
  }
}

async function migrateConsumerWalletLocked(
  accountId: string,
  staleId: string
): Promise<MigrationOutcome> {
  const blockchain = getNetworkConfig().circleBlockchain;
  return prisma.$transaction(
    async (db: any) => {
      await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", advisoryLockKey(accountId));
      const locked = await db.consumerAccount.findUnique({ where: { id: accountId } });
      if (!locked) {
        throw new ConsumerFeatureError(404, "ACCOUNT_NOT_FOUND", "Account not found.");
      }
      // Re-check after the lock: a concurrent login may have migrated
      // already — return its row instead of minting again.
      if (!locked.circleWalletId || locked.circleWalletId !== staleId) {
        return {
          migrated: false,
          walletAddress: String(locked.walletAddress ?? ""),
          circleWalletId: locked.circleWalletId ?? null,
          noticePending: !!locked.migrationNoticePending,
        };
      }
      const circleClient = getCircleClient();
      let walletSetId: string;
      let walletId: string;
      let address: string;
      try {
        const setRes: any = await circleClient.createWalletSet({
          idempotencyKey: migrationIdempotencyKey(accountId, "set"),
          name: `consumer_migrate_${accountId.slice(0, 8)}`,
        });
        walletSetId = setRes?.data?.walletSet?.id ?? "";
        if (!walletSetId) throw new Error("wallet-set creation returned no id");
        const walletsRes: any = await circleClient.createWallets({
          idempotencyKey: migrationIdempotencyKey(accountId, "wallets"),
          blockchains: [blockchain as any],
          count: 1,
          walletSetId,
          accountType: "SCA",
        });
        const wallet = walletsRes?.data?.wallets?.[0];
        walletId = wallet?.id ?? "";
        address = wallet?.address ?? "";
        if (!walletId || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
          throw new Error("wallet creation returned no id/address");
        }
      } catch (e: any) {
        // Transaction rolls back; the stable idempotency keys make a later
        // retry replay Circle-side instead of minting duplicates.
        throw new ConsumerFeatureError(
          502,
          "WALLET_CREATE_FAILED",
          "Could not create your wallet right now. Try again."
        );
      }
      const history = Array.isArray(locked.previousWallets) ? [...locked.previousWallets] : [];
      history.push({
        walletId: staleId,
        walletAddress: String(locked.walletAddress ?? ""),
        migratedAt: new Date().toISOString(),
        reason: "mainnet-upgrade",
      });
      const updated = await db.consumerAccount.update({
        where: { id: accountId },
        data: {
          circleWalletId: walletId,
          walletAddress: address,
          previousWallets: history,
          walletMigratedAt: new Date(),
          migrationNoticePending: true,
        },
      });
      return {
        migrated: true,
        walletAddress: String(updated.walletAddress),
        circleWalletId: updated.circleWalletId,
        noticePending: true,
      };
    },
    { timeout: 30000 }
  );
}

/**
 * Send-path liveness check for a CIRCLE consumer row: the stored wallet id
 * must still resolve under the production key. Clean 404 → friendly
 * re-login signal (never the raw Circle error); any other lookup failure →
 * try-again. Non-CIRCLE rows are out of scope (their own custody errors
 * apply upstream).
 */
export async function assertConsumerCircleWalletLive(account: {
  walletType?: string | null;
  circleWalletId?: string | null;
  walletAddress?: string | null;
}): Promise<void> {
  if (account?.walletType !== "CIRCLE" || !account.circleWalletId) return;
  try {
    const res: any = await getCircleClient().getWallet({ id: account.circleWalletId });
    if (res?.data?.wallet) return;
    throw new ConsumerFeatureError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
  } catch (err: any) {
    if (err instanceof ConsumerFeatureError) throw err;
    if (isCircleClean404(err)) {
      throw new ConsumerFeatureError(409, "WALLET_NEEDS_UPDATE", WALLET_NEEDS_UPDATE_MESSAGE);
    }
    throw new ConsumerFeatureError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
  }
}
