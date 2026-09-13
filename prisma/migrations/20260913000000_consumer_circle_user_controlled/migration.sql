-- Additive Circle user-controlled wallet binding for ConsumerAccount.
--   - ConsumerAccount.circleUserId: the Circle user-controlled `userId`
--     returned alongside the userToken after Google / email-OTP
--     authentication. @unique so a returning Google/email identity resolves
--     to its existing row instead of creating a duplicate account.
-- No destructive SQL, no rewrites, no data loss. Existing rows untouched
-- (new column nullable). walletType stays an open string; the new
-- "USER_CONTROLLED" value is a data convention, not a schema change.

-- AlterTable "ConsumerAccount"
ALTER TABLE "ConsumerAccount" ADD COLUMN "circleUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerAccount_circleUserId_key" ON "ConsumerAccount"("circleUserId");
