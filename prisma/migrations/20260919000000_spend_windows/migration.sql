-- CreateTable
CREATE TABLE "spend_windows" (
    "id" TEXT NOT NULL,
    "payerAddress" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "spentMicros" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spend_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spend_windows_payerAddress_key" ON "spend_windows"("payerAddress");