import { PrismaClient } from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Single shared client in every environment (dev HMR-safe via globalThis,
// production-safe via the same module-cache + explicit assignment —
// previously production relied on the module cache alone, so each hot
// code path risked its own pool under serverless scale-out).
export const prisma = globalForPrisma.prisma || new PrismaClient();

globalForPrisma.prisma = prisma;
