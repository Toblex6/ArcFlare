-- Additive Phase 2C multicurrency columns.
-- Gives NanoPayment, ScheduledPayment and PayrollBatch the same canonical
-- `tokenAddress` identity PaymentLog and AgentLedgerEntry gained in Phase 1
-- (20260905040000_add_payment_token_address). NULL stays valid and resolves
-- to USDC via resolveRowCurrency (historical rows are USDC by convention —
-- additive columns only; existing rows and values are left untouched).

-- AlterTable "NanoPayment"
ALTER TABLE "NanoPayment" ADD COLUMN "tokenAddress" TEXT;

-- AlterTable "ScheduledPayment"
ALTER TABLE "ScheduledPayment" ADD COLUMN "tokenAddress" TEXT;

-- AlterTable "PayrollBatch"
ALTER TABLE "PayrollBatch" ADD COLUMN "tokenAddress" TEXT;
