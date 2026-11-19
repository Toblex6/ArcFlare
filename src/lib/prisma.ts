import { PrismaClient } from '@prisma/client';
import { getArcChain } from '@/lib/config/network';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Single shared client in every environment (dev HMR-safe via globalThis,
// production-safe via the same module-cache + explicit assignment —
// previously production relied on the module cache alone, so each hot
// code path risked its own pool under serverless scale-out).
function createPrismaClient(): PrismaClient {
  return new PrismaClient().$extends({
    name: 'payment-network-metadata',
    query: {
      paymentLog: {
        create({ args, query }) {
          // withGateway() is frozen. Normalize only its legacy logging label
          // at persistence; no payment, auth, schema or settlement changes.
          if (args.data.chain === 'Arc Testnet x402') {
            args = { ...args, data: { ...args.data, chain: `${getArcChain().name} x402` } };
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

globalForPrisma.prisma = prisma;
