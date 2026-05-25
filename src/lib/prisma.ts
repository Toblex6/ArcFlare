import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// Instantiate the client safely to prevent multiple connections in development
export const prisma = globalForPrisma.prisma || new PrismaClient();

// Secondary alias export so files utilizing 'db' imports function perfectly
export const db = prisma;

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;