-- Checkout cross-chain payment binding.
-- One CCTP burn settles exactly one invoice; recovery reuses the same
-- FlowBridgeIntent row (no second burn). Additive and nullable: existing
-- external-bridge intents keep invoiceReference = NULL.
ALTER TABLE "flow_bridge_intents" ADD COLUMN "invoiceReference" TEXT;
CREATE UNIQUE INDEX "flow_bridge_intents_invoiceReference_key" ON "flow_bridge_intents"("invoiceReference");
