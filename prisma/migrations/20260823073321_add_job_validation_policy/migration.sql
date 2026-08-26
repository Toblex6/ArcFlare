-- CreateTable
CREATE TABLE "erc8183_job_validations" (
    "id" TEXT NOT NULL,
    "jobId" BIGINT NOT NULL,
    "validatorSCA" TEXT NOT NULL,
    "requestHash" TEXT,
    "requestTxHash" TEXT,
    "responseTxHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "tag" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "erc8183_job_validations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "erc8183_job_validations_jobId_key" ON "erc8183_job_validations"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "erc8183_job_validations_requestHash_key" ON "erc8183_job_validations"("requestHash");

-- CreateIndex
CREATE INDEX "erc8183_job_validations_validatorSCA_idx" ON "erc8183_job_validations"("validatorSCA");

-- CreateIndex
CREATE INDEX "erc8183_job_validations_status_idx" ON "erc8183_job_validations"("status");

-- AddForeignKey
ALTER TABLE "erc8183_job_validations" ADD CONSTRAINT "erc8183_job_validations_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "erc8183_jobs"("jobId") ON DELETE CASCADE ON UPDATE CASCADE;
