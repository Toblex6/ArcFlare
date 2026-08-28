-- CreateTable
CREATE TABLE "agent_provider_policies" (
    "id" SERIAL NOT NULL,
    "agentRegistryId" INTEGER NOT NULL,
    "minBudget" TEXT NOT NULL DEFAULT '0',
    "maxConcurrentJobs" INTEGER NOT NULL DEFAULT 5,
    "minClientTrustScore" INTEGER,
    "allowedSkills" JSONB,
    "allowedCategories" JSONB,
    "autoAccept" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_provider_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_postings" (
    "id" TEXT NOT NULL,
    "clientAgentId" INTEGER NOT NULL,
    "clientSCA" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT NOT NULL,
    "requirements" JSONB,
    "budgetMax" TEXT NOT NULL,
    "budgetMin" TEXT,
    "skill" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "selectedProviderId" INTEGER,
    "selectedProviderSCA" TEXT,
    "resultingJobId" BIGINT,
    "merchantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "procurement_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "procurement_applications" (
    "id" TEXT NOT NULL,
    "procurementId" TEXT NOT NULL,
    "applicantAgentId" INTEGER,
    "applicantAddress" TEXT NOT NULL,
    "pitch" TEXT NOT NULL,
    "proposedAmount" TEXT,
    "portfolioLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "procurement_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "agent_provider_policies_agentRegistryId_key" ON "agent_provider_policies"("agentRegistryId");

-- CreateIndex
CREATE INDEX "procurement_postings_clientAgentId_idx" ON "procurement_postings"("clientAgentId");

-- CreateIndex
CREATE INDEX "procurement_postings_status_idx" ON "procurement_postings"("status");

-- CreateIndex
CREATE INDEX "procurement_applications_procurementId_idx" ON "procurement_applications"("procurementId");

-- CreateIndex
CREATE UNIQUE INDEX "procurement_applications_procurementId_applicantAddress_key" ON "procurement_applications"("procurementId", "applicantAddress");

-- AddForeignKey
ALTER TABLE "agent_provider_policies" ADD CONSTRAINT "agent_provider_policies_agentRegistryId_fkey" FOREIGN KEY ("agentRegistryId") REFERENCES "AgentRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_postings" ADD CONSTRAINT "procurement_postings_clientAgentId_fkey" FOREIGN KEY ("clientAgentId") REFERENCES "AgentRegistry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "procurement_applications" ADD CONSTRAINT "procurement_applications_procurementId_fkey" FOREIGN KEY ("procurementId") REFERENCES "procurement_postings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
