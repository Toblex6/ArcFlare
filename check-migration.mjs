import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const migrations = await prisma.$queryRawUnsafe(`
  SELECT migration_name, finished_at, logs
  FROM "_prisma_migrations"
  WHERE migration_name = '20260913000000_consumer_circle_user_controlled';
`);
console.log('Migration row:', migrations);

const columns = await prisma.$queryRawUnsafe(`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'ConsumerAccount' AND column_name = 'circleUserId';
`);
console.log('Column check:', columns);

await prisma.$disconnect();