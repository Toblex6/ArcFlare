-- Standalone ArcFlareStream lifecycle (no ERC-8183 dependency).
CREATE TABLE "standalone_streams" (
  "id" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "streamId" TEXT NOT NULL,
  "posterAddress" TEXT NOT NULL,
  "posterActorType" TEXT NOT NULL,
  "posterActorId" TEXT NOT NULL,
  "workerAddress" TEXT NOT NULL,
  "workerActorType" TEXT,
  "workerActorId" TEXT,
  "totalBudget" TEXT NOT NULL,
  "trancheCount" INTEGER NOT NULL,
  "tranchesReleased" INTEGER NOT NULL DEFAULT 0,
  "totalReleased" TEXT NOT NULL DEFAULT '0',
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "txHash" TEXT NOT NULL,
  "closeTxHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  CONSTRAINT "standalone_streams_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "standalone_stream_tranches" (
  "id" TEXT NOT NULL,
  "streamReference" TEXT NOT NULL,
  "requirementIndex" INTEGER NOT NULL,
  "amount" TEXT NOT NULL,
  "txHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "standalone_stream_tranches_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "standalone_streams_reference_key" ON "standalone_streams"("reference");
CREATE UNIQUE INDEX "standalone_streams_streamId_key" ON "standalone_streams"("streamId");
CREATE INDEX "standalone_streams_posterAddress_idx" ON "standalone_streams"("posterAddress");
CREATE INDEX "standalone_streams_workerAddress_idx" ON "standalone_streams"("workerAddress");
CREATE INDEX "standalone_streams_status_idx" ON "standalone_streams"("status");
CREATE UNIQUE INDEX "standalone_stream_tranches_streamReference_requirementIndex_key" ON "standalone_stream_tranches"("streamReference", "requirementIndex");
CREATE INDEX "standalone_stream_tranches_streamReference_idx" ON "standalone_stream_tranches"("streamReference");
ALTER TABLE "standalone_stream_tranches" ADD CONSTRAINT "standalone_stream_tranches_streamReference_fkey" FOREIGN KEY ("streamReference") REFERENCES "standalone_streams"("reference") ON DELETE CASCADE ON UPDATE CASCADE;
