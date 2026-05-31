-- This cleans the migration history so your new 0_init migration can take over
DROP TABLE IF EXISTS "_prisma_migrations";

-- Now, force Prisma to think it has already run the migration
CREATE TABLE "_prisma_migrations" (
    "id" VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum" VARCHAR(64) NOT NULL,
    "finished_at" TIMESTAMPTZ,
    "migration_name" VARCHAR(255) NOT NULL,
    "logs" TEXT,
    "rolled_back_at" TIMESTAMPTZ,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);

INSERT INTO "_prisma_migrations" (id, checksum, migration_name, finished_at, applied_steps_count)
VALUES ('00000000-0000-0000-0000-000000000000', 'dummy', '0_init', NOW(), 1);