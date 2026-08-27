-- CreateTable
CREATE TABLE "agent_ledger_entries" (
    "id" TEXT NOT NULL,
    "agentRegistryId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "token" TEXT NOT NULL DEFAULT 'USDC',
    "direction" TEXT NOT NULL,
    "counterpartyAgentId" INTEGER,
    "paymentLogId" TEXT,
    "jobId" BIGINT,
    "jobValidationId" TEXT,
    "streamId" TEXT,
    "txHash" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_treasury_policies" (
    "id" SERIAL NOT NULL,
    "agentRegistryId" INTEGER NOT NULL,
    "reserveMinimum" TEXT NOT NULL DEFAULT '0',
    "maxSpendPerJob" TEXT NOT NULL DEFAULT '0',
    "maxSpendPerDay" TEXT NOT NULL DEFAULT '0',
    "maxSubcontractorSpendPerDay" TEXT NOT NULL DEFAULT '0',
    "autoPaySubcontractors" BOOLEAN NOT NULL DEFAULT false,
    "reinvestPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_treasury_policies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_ledger_entries_dedupeKey_key" ON "agent_ledger_entries"("dedupeKey");

-- CreateIndex
CREATE INDEX "agent_ledger_entries_agentRegistryId_createdAt_idx" ON "agent_ledger_entries"("agentRegistryId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_ledger_entries_agentRegistryId_type_idx" ON "agent_ledger_entries"("agentRegistryId", "type");

-- CreateIndex
CREATE INDEX "agent_ledger_entries_txHash_idx" ON "agent_ledger_entries"("txHash");

-- CreateIndex
CREATE INDEX "agent_ledger_entries_jobId_idx" ON "agent_ledger_entries"("jobId");

-- CreateIndex
CREATE INDEX "agent_ledger_entries_jobValidationId_idx" ON "agent_ledger_entries"("jobValidationId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_treasury_policies_agentRegistryId_key" ON "agent_treasury_policies"("agentRegistryId");

-- AddForeignKey
ALTER TABLE "agent_ledger_entries" ADD CONSTRAINT "agent_ledger_entries_agentRegistryId_fkey" FOREIGN KEY ("agentRegistryId") REFERENCES "AgentRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ledger_entries" ADD CONSTRAINT "agent_ledger_entries_paymentLogId_fkey" FOREIGN KEY ("paymentLogId") REFERENCES "PaymentLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_ledger_entries" ADD CONSTRAINT "agent_ledger_entries_jobValidationId_fkey" FOREIGN KEY ("jobValidationId") REFERENCES "erc8183_job_validations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_treasury_policies" ADD CONSTRAINT "agent_treasury_policies_agentRegistryId_fkey" FOREIGN KEY ("agentRegistryId") REFERENCES "AgentRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
