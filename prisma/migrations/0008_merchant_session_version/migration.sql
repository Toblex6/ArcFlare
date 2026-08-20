-- M18: session invalidation version — every merchant session token carries
-- the sessionVersion the account had when it was issued. Bumping the column
-- (password reset) invalidates ALL outstanding cookie sessions at once,
-- because the middleware refuses tokens whose claim is stale/missing.
ALTER TABLE "Merchant" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;