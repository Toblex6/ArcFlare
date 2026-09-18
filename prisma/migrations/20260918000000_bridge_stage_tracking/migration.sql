-- Bridge stage tracking: append-only diagnostic log for EXTERNAL bridge attempts.
--
--   - New table "bridge_attempt_stages": one row per stage transition on a
--     FlowBridgeIntent, with timestamp, txHash, chainId, raw errorDetail, and
--     optional JSON metadata. Current stage = latest row by createdAt.
--   - Purely observability — no execution logic is gated on these rows.
--   - Additive only. Existing tables, indexes, and rows are unchanged.

-- CreateTable
CREATE TABLE IF NOT EXISTS "bridge_attempt_stages" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "txHash" TEXT,
    "chainId" INTEGER,
    "errorDetail" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bridge_attempt_stages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "bridge_attempt_stages_intentId_idx" ON "bridge_attempt_stages"("intentId");
CREATE INDEX IF NOT EXISTS "bridge_attempt_stages_intentId_createdAt_idx" ON "bridge_attempt_stages"("intentId", "createdAt");
