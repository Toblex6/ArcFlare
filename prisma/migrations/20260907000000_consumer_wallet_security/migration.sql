-- Additive consumer wallet-security fields (Stage 2: email recovery + PIN step-up).
--   - ConsumerAccount.pinHash: bcrypt hash of the 4–6 digit step-up PIN (null = not enrolled).
--   - ConsumerAccount.pinFailedAttempts / pinLockedUntil: lockout/backoff counters.
--   - ConsumerAccount.emailVerifiedAt: OTP-proven timestamp; recovery requires non-null.
--   - consumer_email_otps: short-lived single-use OTP rows; only the SHA-256
--     hash of the code is stored, never the raw code.
-- No destructive SQL, no rewrites, no data loss. Existing rows untouched
-- (new columns nullable / defaulted).

-- AlterTable "ConsumerAccount"
ALTER TABLE "ConsumerAccount" ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "ConsumerAccount" ADD COLUMN "pinHash" TEXT;
ALTER TABLE "ConsumerAccount" ADD COLUMN "pinFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ConsumerAccount" ADD COLUMN "pinLockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "consumer_email_otps" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consumer_email_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "consumer_email_otps_email_idx" ON "consumer_email_otps"("email");
CREATE INDEX "consumer_email_otps_expiresAt_idx" ON "consumer_email_otps"("expiresAt");
