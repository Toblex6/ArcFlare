-- EXTERNAL Bridge intents (browser-signed CCTP via BridgeKit).
--
--   - New table "flow_bridge_intents": self-custody record for EXTERNAL-wallet
--     USDC bridges into the consumer's own FlareHQ CIRCLE wallet on Arc.
--     The server never signs here; it issues the intent (server-resolved
--     destination) and verifies browser-submitted burn/mint transactions
--     against on-chain receipts before advancing state.
--   - No walletSetId, no wallet-set binding, no custody change anywhere:
--     ConsumerAccount is untouched by this migration.
--   - Additive only. Existing tables, indexes, and rows are unchanged.

-- CreateTable
CREATE TABLE IF NOT EXISTS "flow_bridge_intents" (
    "id" TEXT NOT NULL,
    "sourceWallet" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "sourceChain" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "burnTxHash" TEXT,
    "mintTxHash" TEXT,
    "actualAmount" TEXT,
    "destinationBound" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flow_bridge_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "flow_bridge_intents_burnTxHash_key" ON "flow_bridge_intents"("burnTxHash");
CREATE UNIQUE INDEX IF NOT EXISTS "flow_bridge_intents_mintTxHash_key" ON "flow_bridge_intents"("mintTxHash");
CREATE INDEX IF NOT EXISTS "flow_bridge_intents_sourceWallet_idx" ON "flow_bridge_intents"("sourceWallet");
CREATE INDEX IF NOT EXISTS "flow_bridge_intents_destination_idx" ON "flow_bridge_intents"("destination");
CREATE INDEX IF NOT EXISTS "flow_bridge_intents_status_idx" ON "flow_bridge_intents"("status");
