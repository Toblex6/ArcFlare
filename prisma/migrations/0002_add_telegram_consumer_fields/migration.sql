-- AlterTable
ALTER TABLE "ConsumerAccount" ADD COLUMN     "onboardingSource" TEXT,
ADD COLUMN     "telegramUserId" TEXT;

-- CreateTable
CREATE TABLE "telegram_withdrawal_intents" (
    "id" TEXT NOT NULL,
    "telegramUserId" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "amount" TEXT NOT NULL DEFAULT 'ALL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telegram_withdrawal_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "telegram_withdrawal_intents_telegramUserId_key" ON "telegram_withdrawal_intents"("telegramUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ConsumerAccount_telegramUserId_key" ON "ConsumerAccount"("telegramUserId");

