-- Additive Phase 1 multicurrency read-model columns.
-- Adds a canonical `tokenAddress` to PaymentLog and AgentLedgerEntry so payment
-- records carry the exact settlement token identity. NULL stays valid and is
-- interpreted as USDC (legacy rows unchanged — no backfill, no data rewrite).

-- AlterTable "PaymentLog"
ALTER TABLE "PaymentLog" ADD COLUMN "tokenAddress" TEXT;

-- AlterTable "agent_ledger_entries"
ALTER TABLE "agent_ledger_entries" ADD COLUMN "tokenAddress" TEXT;