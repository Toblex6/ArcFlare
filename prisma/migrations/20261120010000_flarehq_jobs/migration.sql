-- FlareHQ Jobs: application + lifecycle rows backed by FlareHQEscrow.
-- Deliberately separate from erc8183_jobs; this feature is not ERC-8183.
CREATE TABLE "flarehq_jobs" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "title" TEXT,
    "description" TEXT NOT NULL,
    "requirements" JSONB,
    "budget" TEXT NOT NULL,
    "clientAddress" TEXT NOT NULL,
    "clientActorType" TEXT NOT NULL,
    "clientActorId" TEXT NOT NULL,
    "providerAddress" TEXT,
    "providerActorType" TEXT,
    "providerActorId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "escrowReference" TEXT,
    "deliverable" TEXT,
    "deliverableHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "flarehq_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flarehq_job_applications" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "applicantAddress" TEXT NOT NULL,
    "applicantType" TEXT NOT NULL,
    "applicantActorId" TEXT NOT NULL,
    "pitch" TEXT NOT NULL,
    "proposedAmount" TEXT,
    "portfolioLinks" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "flarehq_job_applications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flarehq_jobs_seq_key" ON "flarehq_jobs"("seq");
CREATE UNIQUE INDEX "flarehq_jobs_escrowReference_key" ON "flarehq_jobs"("escrowReference");
CREATE INDEX "flarehq_jobs_clientAddress_idx" ON "flarehq_jobs"("clientAddress");
CREATE INDEX "flarehq_jobs_providerAddress_idx" ON "flarehq_jobs"("providerAddress");
CREATE INDEX "flarehq_jobs_status_idx" ON "flarehq_jobs"("status");
CREATE UNIQUE INDEX "flarehq_job_applications_jobId_applicantAddress_key" ON "flarehq_job_applications"("jobId", "applicantAddress");
CREATE INDEX "flarehq_job_applications_jobId_idx" ON "flarehq_job_applications"("jobId");
ALTER TABLE "flarehq_job_applications" ADD CONSTRAINT "flarehq_job_applications_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "flarehq_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
