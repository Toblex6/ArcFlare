-- Swap-backend stage: shared swap/conversion application layer.
-- Additive only — no rewrites, no data loss, no PaymentLog changes.
--
-- 1. payment_conversions: UnitFlow provider binding columns. venueId
--    backfills 'canonical' on existing rows so the current canonical
--    checkout path is unchanged. executionIdentity / wrapTxHash are
--    uniqueness-enforced replay/audit ids (NULL = canonical path; PG
--    treats NULLs as distinct). The *Swap columns persist the exact
--    swap-leg quote binding the pure UnitFlow verifier consumes.
-- 2. flow_swap_intents: dedicated Flow Swap intent/execution record.
--    NOT a second payment ledger — v1 is payer == recipient ==
--    ownerWallet (authenticated consumer session wallet). Amounts:
--    inputAmount is canonical 6-dec base units; the *Swap columns are the
--    exact swap-leg views (18-dec on the USDC/WUSDC leg, 6-dec EURC).
--    deadline is a bigint string (same convention as amount strings).
--
-- NOTE: this directory was found empty (prisma migrate status P3015), while
-- the Neon dev database already carried these objects from the earlier
-- partial run. This file reconstructs that applied migration so fresh
-- databases converge to the same schema (column set, types, defaults, and
-- index names verified against information_schema/pg_indexes on dev).

-- AlterTable "payment_conversions": UnitFlow provider binding
ALTER TABLE "payment_conversions" ADD COLUMN "venueId" TEXT NOT NULL DEFAULT 'canonical';
ALTER TABLE "payment_conversions" ADD COLUMN "deploymentName" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "deploymentRouter" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "feeTier" INTEGER;
ALTER TABLE "payment_conversions" ADD COLUMN "executionIdentity" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "expectedPayer" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "slippageBps" INTEGER;
ALTER TABLE "payment_conversions" ADD COLUMN "wrapTxHash" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "tokenInSwap" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "tokenOutSwap" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "amountInSwap" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "quotedOutputSwap" TEXT;
ALTER TABLE "payment_conversions" ADD COLUMN "minOutputSwap" TEXT;

-- CreateIndex (unique execution identity for replay/single-consumption)
CREATE UNIQUE INDEX "payment_conversions_executionIdentity_key" ON "payment_conversions"("executionIdentity");

-- CreateIndex (unique wrap-tx audit id; NULLs exempt)
CREATE UNIQUE INDEX "payment_conversions_wrapTxHash_key" ON "payment_conversions"("wrapTxHash");

-- CreateTable "flow_swap_intents"
CREATE TABLE "flow_swap_intents" (
    "id" TEXT NOT NULL,
    "ownerWallet" TEXT NOT NULL,
    "inputSymbol" TEXT NOT NULL,
    "outputSymbol" TEXT NOT NULL,
    "inputAmount" TEXT NOT NULL,
    "inputAmountSwap" TEXT NOT NULL,
    "tokenInSwap" TEXT NOT NULL,
    "tokenOutSwap" TEXT NOT NULL,
    "quotedOutputSwap" TEXT NOT NULL,
    "minOutputSwap" TEXT NOT NULL,
    "venueId" TEXT NOT NULL DEFAULT 'unitflow-v3',
    "deploymentName" TEXT NOT NULL,
    "deploymentRouter" TEXT NOT NULL,
    "poolAddress" TEXT NOT NULL,
    "feeTier" INTEGER NOT NULL,
    "slippageBps" INTEGER NOT NULL,
    "quoteExpiresAt" TIMESTAMP(3) NOT NULL,
    "deadline" TEXT NOT NULL,
    "quoteHash" TEXT NOT NULL,
    "executionIdentity" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expectedPayer" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "wrapTxHash" TEXT,
    "executionTxHash" TEXT,
    "actualInputAmount" TEXT,
    "actualOutputAmount" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUOTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_swap_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "flow_swap_intents_quoteHash_key" ON "flow_swap_intents"("quoteHash");

-- CreateIndex
CREATE UNIQUE INDEX "flow_swap_intents_idempotencyKey_key" ON "flow_swap_intents"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "flow_swap_intents_executionIdentity_key" ON "flow_swap_intents"("executionIdentity");

-- CreateIndex
CREATE UNIQUE INDEX "flow_swap_intents_executionTxHash_key" ON "flow_swap_intents"("executionTxHash");

-- CreateIndex (unique wrap-tx audit id; NULLs exempt)
CREATE UNIQUE INDEX "flow_swap_intents_wrapTxHash_key" ON "flow_swap_intents"("wrapTxHash");

-- CreateIndex
CREATE INDEX "flow_swap_intents_ownerWallet_idx" ON "flow_swap_intents"("ownerWallet");

-- CreateIndex
CREATE INDEX "flow_swap_intents_status_idx" ON "flow_swap_intents"("status");
