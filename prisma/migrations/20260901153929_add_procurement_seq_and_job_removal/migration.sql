-- AlterTable
ALTER TABLE "erc8183_jobs" ADD COLUMN     "removedAt" TIMESTAMP(3),
ADD COLUMN     "removedReason" TEXT;

-- AlterTable
ALTER TABLE "procurement_postings" ADD COLUMN     "seq" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "procurement_postings_seq_key" ON "procurement_postings"("seq");
