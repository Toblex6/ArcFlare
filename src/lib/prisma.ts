// Import from your custom generated path instead of standard node_modules
import { PrismaClient } from "../generated/client"; 

const globalForPrisma = global as unknown as { prisma: PrismaClient };

export const db = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;