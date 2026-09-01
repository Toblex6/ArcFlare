-- AlterTable
ALTER TABLE "Escrow" ADD COLUMN "beneficiaryKind" TEXT,
ADD COLUMN "beneficiaryNotifiedAt" TIMESTAMP(3);
