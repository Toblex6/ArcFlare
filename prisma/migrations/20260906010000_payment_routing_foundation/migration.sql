-- Additive Payment Routing v1 foundation.
--   - PaymentLog.payTokenAddress: token the customer actually pays (X).
--     NULL = same-token/legacy payment; settlement semantics of
--     amount + currency + tokenAddress (Y) are unchanged.
--   - payment_conversions: 1:1 optional child of PaymentLog, created only
--     when X != Y. Amounts are exact integer/base-unit strings (never float).
--   - Merchant.settlementTokenAddress: default settlement token for FUTURE
--     invoices (canonical address, NULL = USDC). Existing rows untouched.
-- No destructive SQL, no rewrites, no data loss.

-- AlterTable "PaymentLog"
ALTER TABLE "PaymentLog" ADD COLUMN "payTokenAddress" TEXT;

-- AlterTable "Merchant"
ALTER TABLE "Merchant" ADD COLUMN "settlementTokenAddress" TEXT;

-- CreateTable
CREATE TABLE "payment_conversions" (
    "id" TEXT NOT NULL,
    "paymentLogId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUOTED',
    "inputTokenAddress" TEXT NOT NULL,
    "inputAmount" TEXT NOT NULL,
    "outputTokenAddress" TEXT NOT NULL,
    "quotedOutputAmount" TEXT NOT NULL,
    "minOutputAmount" TEXT NOT NULL,
    "quoteExpiresAt" TIMESTAMP(3) NOT NULL,
    "quoteHash" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "executionTxHash" TEXT,
    "actualInputAmount" TEXT,
    "actualOutputAmount" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_conversions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_conversions_paymentLogId_key" ON "payment_conversions"("paymentLogId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conversions_quoteHash_key" ON "payment_conversions"("quoteHash");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conversions_idempotencyKey_key" ON "payment_conversions"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payment_conversions_executionTxHash_key" ON "payment_conversions"("executionTxHash");

-- CreateIndex
CREATE INDEX "payment_conversions_status_idx" ON "payment_conversions"("status");

-- CreateIndex
CREATE INDEX "payment_conversions_quoteExpiresAt_idx" ON "payment_conversions"("quoteExpiresAt");

-- AddForeignKey
ALTER TABLE "payment_conversions" ADD CONSTRAINT "payment_conversions_paymentLogId_fkey" FOREIGN KEY ("paymentLogId") REFERENCES "PaymentLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
