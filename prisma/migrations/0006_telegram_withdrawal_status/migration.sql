-- H6: Telegram withdrawal intents get an explicit claim state so a webhook
-- retry / double /confirm can never execute two transfers from one intent.
ALTER TABLE "telegram_withdrawal_intents" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';