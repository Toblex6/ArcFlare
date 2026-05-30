// prisma.config.ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

// 💡 THE FIX: Remove the 'env' import entirely and use native process.env
const prismaConfig: any = {
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL || "file:./dev.db",
  },
};

export default defineConfig(prismaConfig);