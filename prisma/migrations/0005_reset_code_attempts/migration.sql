-- 0005_reset_code_attempts
-- H9: brute-force attempt counter on merchant password-reset codes.
-- Code is burned after 5 failed attempts (see reset-password route).
ALTER TABLE "Merchant" ADD COLUMN "resetCodeAttempts" INTEGER NOT NULL DEFAULT 0;