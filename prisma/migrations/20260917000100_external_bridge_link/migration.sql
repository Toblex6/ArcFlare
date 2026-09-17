-- EXTERNAL bridge-destination link (server-set, no custody change).
--
--   - Adds ConsumerAccount.linkedCircleAddress (nullable): the FlareHQ
--     CIRCLE walletAddress on Arc that an EXTERNAL wallet's bridges pay.
--     Written ONLY by the server when it provisions that CIRCLE wallet from
--     the EXTERNAL session (POST /api/consumer/flare-wallet); never
--     browser-writable.
--   - This is NOT walletSetId: no wallet-set id is stored anywhere in the
--     consumer model (the retired walletSetId column stays dropped).
--   - Additive only. Existing tables, indexes, and rows are unchanged
--     (all existing rows read NULL = unlinked = bridge intent fails closed
--     with CIRCLE_WALLET_UNBOUND until linked).

-- AlterTable "ConsumerAccount"
ALTER TABLE "ConsumerAccount" ADD COLUMN IF NOT EXISTS "linkedCircleAddress" TEXT;
