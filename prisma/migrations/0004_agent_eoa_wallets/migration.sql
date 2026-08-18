-- AlterTable
ALTER TABLE "x402_eoa_wallets" ADD COLUMN "agentRegistryId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "x402_eoa_wallets_agentRegistryId_key" ON "x402_eoa_wallets"("agentRegistryId");