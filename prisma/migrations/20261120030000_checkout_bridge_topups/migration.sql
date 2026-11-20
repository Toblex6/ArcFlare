ALTER TABLE "flow_bridge_intents" ADD COLUMN "checkoutTopUpReference" TEXT, ADD COLUMN "checkoutTopUpAfter" TEXT;
CREATE INDEX "flow_bridge_intents_checkoutTopUpReference_idx" ON "flow_bridge_intents"("checkoutTopUpReference");
CREATE UNIQUE INDEX "flow_bridge_intents_checkoutTopUpAfter_key" ON "flow_bridge_intents"("checkoutTopUpAfter");
