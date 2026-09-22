-- Bridge attested-nonce correction: CCTP V2 emits MessageSent with
-- EMPTY_NONCE (bytes32 zeros) by construction — Circle assigns the real
-- message nonce offchain and the attesters fill it before signing (see
-- src/lib/bridge/irisNonce.ts). Any row that recorded the zero placeholder
-- as its binding nonce could never complete a genuine mint, and (as a
-- non-NULL UNIQUE value) a second such row would even collide on the unique
-- index. Clear placeholders to NULL (unbound); completion re-resolves the
-- attested nonce from Iris by burn hash. Idempotent data-only migration.

UPDATE "flow_bridge_intents"
SET "cctpNonce" = NULL
WHERE "cctpNonce" = '0x0000000000000000000000000000000000000000000000000000000000000000';
