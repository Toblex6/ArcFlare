-- Consumer mainnet wallet upgrade history (Step C): when the production
-- Circle key returns a clean 404 for a CIRCLE consumer's circleWalletId at
-- the account's own login, a fresh mainnet ARC SCA wallet is provisioned and
-- bound. previousWallets is append-only history ({ walletId, walletAddress,
-- migratedAt, reason } entries) — nothing is ever deleted or rewritten.
-- migrationNoticePending drives the one-time "wallet upgraded" message and
-- is cleared after it is first shown. Additive only: all columns nullable
-- (or defaulted) so every existing row stays valid untouched.

ALTER TABLE "ConsumerAccount" ADD COLUMN "previousWallets" JSONB;

ALTER TABLE "ConsumerAccount" ADD COLUMN "walletMigratedAt" TIMESTAMPTZ;

ALTER TABLE "ConsumerAccount" ADD COLUMN "migrationNoticePending" BOOLEAN NOT NULL DEFAULT false;
