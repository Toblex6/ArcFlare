-- CreateTable
CREATE TABLE "platform_fees" (
    "id" TEXT NOT NULL,
    "paymentLogId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "amountCharged" DOUBLE PRECISION NOT NULL,
    "amountReceived" DOUBLE PRECISION,
    "status" TEXT NOT NULL,
    "txHash" TEXT,
    "deferredReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_fees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_fees_merchantId_idx" ON "platform_fees"("merchantId");

-- CreateIndex
CREATE INDEX "platform_fees_status_idx" ON "platform_fees"("status");

-- AddForeignKey
ALTER TABLE "platform_fees" ADD CONSTRAINT "platform_fees_paymentLogId_fkey" FOREIGN KEY ("paymentLogId") REFERENCES "PaymentLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;
