-- H8: PayrollBatch rows get an owning merchantId so /api/payroll/run GET
-- status lookups are tenant-scoped (a merchant must not read another
-- merchant's batch). Null for x402-funded rows (no merchant session).
ALTER TABLE "PayrollBatch" ADD COLUMN "merchantId" TEXT;