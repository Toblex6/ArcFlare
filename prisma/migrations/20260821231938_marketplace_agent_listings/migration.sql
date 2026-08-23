-- AlterTable
ALTER TABLE "ApiListing" ADD COLUMN     "agentRegistryId" INTEGER;

-- CreateIndex
CREATE INDEX "ApiListing_agentRegistryId_idx" ON "ApiListing"("agentRegistryId");
