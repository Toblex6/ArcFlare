-- H1 direct-proof single-consumption + platform-fee exactly-once (additive).
-- New table has no existing rows; platform_fees has no duplicate paymentLogId
-- rows (verified 2026-10-04), so both constraints apply cleanly.

CREATE TABLE "direct_payment_proofs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "chainId" INTEGER NOT NULL,
  "txHash" TEXT NOT NULL,
  "logIndex" INTEGER NOT NULL,
  "paymentLogId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "direct_payment_proofs_paymentLogId_fkey"
    FOREIGN KEY ("paymentLogId") REFERENCES "PaymentLog"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "direct_payment_proofs_chainId_txHash_logIndex_key"
  ON "direct_payment_proofs"("chainId", "txHash", "logIndex");
CREATE INDEX "direct_payment_proofs_txHash_idx"
  ON "direct_payment_proofs"("txHash");

ALTER TABLE "platform_fees"
  ADD COLUMN "circleTxId" TEXT,
  ADD COLUMN "idempotencyKey" TEXT;

-- One fee lifecycle per payment. Postgres UNIQUE treats NULLs as distinct,
-- so the nullable idempotencyKey stays safe for legacy rows.
CREATE UNIQUE INDEX "platform_fees_paymentLogId_key"
  ON "platform_fees"("paymentLogId");
CREATE UNIQUE INDEX "platform_fees_idempotencyKey_key"
  ON "platform_fees"("idempotencyKey");
