-- Bridge completion integrity: bind the mint to the burn's CCTP message.
--
--   - New nullable column "flow_bridge_intents"."cctpNonce": the CCTP V2
--     bytes32 message nonce (0x + 64 hex chars) extracted from the burn
--     receipt's MessageSent event at verify time. The complete endpoint
--     requires the Arc mint receipt's MessageReceived event to carry this
--     SAME nonce, so a dust transfer or an unrelated transaction can never
--     be recorded as this intent's mint.
--   - UNIQUE (nullable): the same burn message can never back two intents.
--     Postgres UNIQUE treats NULLs as distinct, so legacy rows (NULL until
--     re-verified) are unaffected.
--   - Additive only. Existing tables, indexes, and rows are unchanged.

-- AlterTable
ALTER TABLE "flow_bridge_intents" ADD COLUMN IF NOT EXISTS "cctpNonce" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "flow_bridge_intents_cctpNonce_key" ON "flow_bridge_intents"("cctpNonce");
