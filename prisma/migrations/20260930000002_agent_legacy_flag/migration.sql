-- Agent test-network origin flag (Step F): marks AgentRegistry rows whose
-- Circle wallet id the production key cannot find (test-era wallets created
-- under the test key). Mainnet hides legacy agents by default and refuses
-- spend/deploy/payments for them; wallet ids are never changed by this
-- flag. Additive only (default false — fresh rows are never legacy).

ALTER TABLE "AgentRegistry" ADD COLUMN "isLegacy" BOOLEAN NOT NULL DEFAULT false;
