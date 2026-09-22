-- M4: consumer session revocation (mirrors merchant sessionVersion)
ALTER TABLE "ConsumerAccount" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
