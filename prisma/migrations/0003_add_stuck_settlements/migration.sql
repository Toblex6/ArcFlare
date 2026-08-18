-- StuckSettlement: durable audit trail + auto-refund tracking for
-- settle-then-reject events (x402 settlement succeeded, but the on-chain
-- spend-limit record checkAndRecordSpend reverted due to a concurrent
-- spend in the race window). See src/lib/jobs/settlementRecovery.ts.
CREATE TABLE "StuckSettlement" (
    "id" TEXT NOT NULL,
    "agentAddress" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "jobCriteriaId" TEXT NOT NULL,
    "gatewayRef" TEXT NOT NULL,
    "settlementTxHash" TEXT NOT NULL,
    "failureReason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REFUND',
    "refundTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StuckSettlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StuckSettlement_agentAddress_status_idx" ON "StuckSettlement"("agentAddress", "status");
CREATE INDEX "StuckSettlement_status_idx" ON "StuckSettlement"("status");
