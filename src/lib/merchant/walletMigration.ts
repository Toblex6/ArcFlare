// src/lib/merchant/walletMigration.ts
//
// Merchant mainnet wallet upgrade (Step E) — same rules as the consumer
// upgrade (src/lib/consumer/walletMigration.ts), on Merchant rows:
//
//   - Provision ONLY on a clean Circle getWallet 404 for circleWalletId.
//     Any other lookup error creates nothing ("try again").
//   - One wallet per merchant: per-account pg advisory lock + SELECT …
//     FOR UPDATE + post-lock re-check, plus stable per-merchant Circle
//     idempotency keys.
//   - Own-login only (merchant/login), mainnet only, CIRCLE rows only.
//     AgentRegistry, EXTERNAL merchants, id-less merchants, and the one
//     healthy merchant are never touched here.
//   - History: replaced id+address appended to previousWallets — nothing
//     deleted. One-time upgrade message via migrationNoticePending.
//
// Live-address resolution (payment time, not link-creation time):
// resolveCurrentMerchantAddress() maps a possibly-stale address to the
// merchant's CURRENT walletAddress (direct match, else previousWallets
// match). Historical PaymentLog rows are never rewritten — they keep their
// recorded address as audit trail while money-moving paths resolve live.

import { prisma } from "@/src/lib/prisma";
import { getCircleClient } from "@/src/lib/circle/client";
import { getNetworkConfig } from "@/src/lib/config/network";
import {
  WALLET_CHECK_RETRY_MESSAGE,
  WALLET_NEEDS_UPDATE_MESSAGE,
  isCircleClean404,
  migrationIdempotencyKey as sharedMigrationKey,
} from "@/src/lib/wallets/upgradeGuards";

export { WALLET_CHECK_RETRY_MESSAGE, WALLET_NEEDS_UPDATE_MESSAGE };

export class MerchantWalletError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "MerchantWalletError";
    this.status = status;
    this.code = code;
  }
}

/** Stable per-merchant Circle idempotency key (merchant namespace). */
export function merchantMigrationIdempotencyKey(
  merchantId: string,
  purpose: "set" | "wallets"
): string {
  return sharedMigrationKey("merchant", merchantId, purpose);
}

export interface MerchantMigrationOutcome {
  migrated: boolean;
  walletAddress: string;
  circleWalletId: string | null;
  noticePending: boolean;
}

function advisoryLockKey(merchantId: string): string {
  return `merchant-wallet-migrate:${merchantId}`;
}

/**
 * Login-time upgrade check for ONE merchant. Creates a wallet only on a
 * clean 404; every other failure throws a typed try-again error and
 * creates nothing. Healthy, id-less, and non-CIRCLE merchants pass
 * through untouched (as do all off-mainnet logins — no writes).
 */
export async function ensureMerchantMainnetWallet(
  merchantId: string
): Promise<MerchantMigrationOutcome> {
  const merchant = await (prisma as any).merchant
    .findUnique({ where: { id: merchantId } })
    .catch(() => null);
  if (!merchant || merchant.walletProvider !== "CIRCLE" || !merchant.circleWalletId) {
    return {
      migrated: false,
      walletAddress: String(merchant?.walletAddress ?? ""),
      circleWalletId: merchant?.circleWalletId ?? null,
      noticePending: !!merchant?.migrationNoticePending,
    };
  }
  if (getNetworkConfig().name !== "mainnet") {
    return {
      migrated: false,
      walletAddress: String(merchant.walletAddress),
      circleWalletId: merchant.circleWalletId,
      noticePending: !!merchant.migrationNoticePending,
    };
  }

  const staleId: string = merchant.circleWalletId;
  const circleClient = getCircleClient();
  try {
    const res: any = await circleClient.getWallet({ id: staleId });
    if (res?.data?.wallet) {
      return {
        migrated: false,
        walletAddress: String(merchant.walletAddress),
        circleWalletId: staleId,
        noticePending: !!merchant.migrationNoticePending,
      };
    }
    throw new MerchantWalletError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
  } catch (err: any) {
    if (err instanceof MerchantWalletError) throw err;
    if (!isCircleClean404(err)) {
      throw new MerchantWalletError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
    }
    return migrateMerchantWalletLocked(merchantId, staleId);
  }
}

async function migrateMerchantWalletLocked(
  merchantId: string,
  staleId: string
): Promise<MerchantMigrationOutcome> {
  const blockchain = getNetworkConfig().circleBlockchain;
  return prisma.$transaction(
    async (db: any) => {
      await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext($1))", advisoryLockKey(merchantId));
      const locked = await db.merchant.findUnique({ where: { id: merchantId } });
      if (!locked) {
        throw new MerchantWalletError(404, "MERCHANT_NOT_FOUND", "Merchant not found.");
      }
      // Post-lock re-check: a concurrent login may have migrated already.
      if (!locked.circleWalletId || locked.circleWalletId !== staleId) {
        return {
          migrated: false,
          walletAddress: String(locked.walletAddress ?? ""),
          circleWalletId: locked.circleWalletId ?? null,
          noticePending: !!locked.migrationNoticePending,
        };
      }
      const circleClient = getCircleClient();
      let walletId: string;
      let address: string;
      try {
        const setRes: any = await circleClient.createWalletSet({
          idempotencyKey: merchantMigrationIdempotencyKey(merchantId, "set"),
          name: `merchant_migrate_${merchantId.slice(0, 8)}`,
        });
        const walletSetId = setRes?.data?.walletSet?.id ?? "";
        if (!walletSetId) throw new Error("wallet-set creation returned no id");
        const walletsRes: any = await circleClient.createWallets({
          idempotencyKey: merchantMigrationIdempotencyKey(merchantId, "wallets"),
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
        throw new MerchantWalletError(
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
      const updated = await db.merchant.update({
        where: { id: merchantId },
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
 * Liveness check for a CIRCLE merchant row (withdraw/wallet paths): the
 * stored wallet id must still resolve. Clean 404 → friendly re-login
 * signal (never the raw Circle error); other failures → try-again.
 */
export async function assertMerchantCircleWalletLive(merchant: {
  walletProvider?: string | null;
  circleWalletId?: string | null;
}): Promise<void> {
  if (merchant?.walletProvider !== "CIRCLE" || !merchant.circleWalletId) return;
  try {
    const res: any = await getCircleClient().getWallet({ id: merchant.circleWalletId });
    if (res?.data?.wallet) return;
    throw new MerchantWalletError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
  } catch (err: any) {
    if (err instanceof MerchantWalletError) throw err;
    if (isCircleClean404(err)) {
      throw new MerchantWalletError(409, "MERCHANT_WALLET_NEEDS_UPDATE", WALLET_NEEDS_UPDATE_MESSAGE);
    }
    throw new MerchantWalletError(503, "WALLET_CHECK_FAILED", WALLET_CHECK_RETRY_MESSAGE);
  }
}

/**
 * Payment-time address resolution (read-only): map a possibly-stale
 * merchant address to the merchant's CURRENT walletAddress. Direct match
 * returns as-is; a previousWallets match returns the row's current
 * address; unknown addresses return as-is (not a merchant — never
 * redirected). Historical rows are never rewritten by this helper.
 */
export async function resolveCurrentMerchantAddress(address: unknown): Promise<string> {
  const raw = typeof address === "string" ? address.trim() : "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return raw;
  const direct = await (prisma as any).merchant
    .findFirst({
      where: { walletAddress: { equals: raw, mode: "insensitive" } },
      select: { walletAddress: true },
    })
    .catch(() => null);
  if (direct?.walletAddress) return direct.walletAddress;
  const candidates = await (prisma as any).merchant
    .findMany({
      where: { previousWallets: { not: null } },
      select: { walletAddress: true, previousWallets: true },
    })
    .catch(() => []);
  for (const m of candidates as any[]) {
    const hist = Array.isArray(m?.previousWallets) ? m.previousWallets : [];
    if (
      hist.some(
        (h: any) => typeof h?.walletAddress === "string" && h.walletAddress.toLowerCase() === raw.toLowerCase()
      ) &&
      typeof m?.walletAddress === "string" &&
      /^0x[a-fA-F0-9]{40}$/.test(m.walletAddress)
    ) {
      return m.walletAddress;
    }
  }
  return raw;
}
