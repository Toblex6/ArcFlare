-- Merchant mainnet wallet upgrade history (Step E, mirrors the consumer
-- 20260930000000 migration): a clean-404 circleWalletId at the merchant's
-- own login provisions one fresh ARC wallet. previousWallets is append-only
-- ({ walletId, walletAddress, migratedAt, reason }) — nothing is ever
-- deleted or rewritten. migrationNoticePending drives the one-time upgrade
-- message. Additive only: all columns nullable (or defaulted).

ALTER TABLE "Merchant" ADD COLUMN "previousWallets" JSONB;

ALTER TABLE "Merchant" ADD COLUMN "walletMigratedAt" TIMESTAMPTZ;

ALTER TABLE "Merchant" ADD COLUMN "migrationNoticePending" BOOLEAN NOT NULL DEFAULT false;
