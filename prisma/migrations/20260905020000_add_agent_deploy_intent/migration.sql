-- CreateTable
CREATE TABLE "AgentDeployIntent" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "walletSetId" TEXT NOT NULL,
    "ownerSca" TEXT NOT NULL,
    "validatorSca" TEXT NOT NULL,
    "circleWalletId" TEXT,
    "idempotencyKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
    "registerTxHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentDeployIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentDeployIntent_walletSetId_key" ON "AgentDeployIntent"("walletSetId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentDeployIntent_merchantId_idempotencyKey_key" ON "AgentDeployIntent"("merchantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AgentDeployIntent_merchantId_status_idx" ON "AgentDeployIntent"("merchantId", "status");

-- CreateIndex
CREATE INDEX "AgentDeployIntent_registerTxHash_idx" ON "AgentDeployIntent"("registerTxHash");
