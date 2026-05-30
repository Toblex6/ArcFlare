// prisma.config.ts

// 💡 THE ULTIMATE FIX: Zero external imports! 
// This prevents the Prisma CLI from crashing on Render when it looks for devDependencies.
const prismaConfig = {
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL || "file:./dev.db",
  },
};

export default prismaConfig;