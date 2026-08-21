/*
  Warnings:

  - Added the required column `token` to the `JobNanopaymentStream` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "JobNanopaymentStream" ADD COLUMN     "criteriaHash" TEXT,
ADD COLUMN     "token" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "PayrollBatch_merchantId_idx" ON "PayrollBatch"("merchantId");
