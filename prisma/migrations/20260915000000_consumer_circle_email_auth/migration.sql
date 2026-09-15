-- Consumer wallet restoration: Circle developer-controlled SCA + external.
--
--   - Drops ConsumerAccount.circleUserId (+ its unique index): the retired
--     Circle user-controlled binding (Google/email Web-SDK identity). No
--     new consumer flow reads or writes it.
--   - Drops ConsumerAccount.walletSetId: the wallet-set binding is NOT part
--     of the consumer design. Developer-controlled signing needs only the
--     bound circleWalletId; do not reintroduce walletSetId here.
--
-- Data preservation: both columns are nullable and carry no funds or
-- identity the new model needs. All rows are preserved untouched —
-- walletAddress, circleWalletId, email, pins, and telegram bindings stay
-- exactly as they are. Existing CIRCLE rows keep their walletAddress +
-- circleWalletId (server-signable); existing EXTERNAL rows stay EXTERNAL.
-- Legacy USER_CONTROLLED walletType VALUES are left as-is (open string):
-- the backend resolver fails them closed and they take no new sessions.

-- DropIndex
DROP INDEX IF EXISTS "ConsumerAccount_circleUserId_key";

-- AlterTable "ConsumerAccount"
ALTER TABLE "ConsumerAccount" DROP COLUMN IF EXISTS "circleUserId";
ALTER TABLE "ConsumerAccount" DROP COLUMN IF EXISTS "walletSetId";
