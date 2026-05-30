// prisma.config.ts
import { defineConfig } from "prisma/config";

// 💡 THE FIX: Removed the dotenv import entirely. 
// Render natively supplies process.env.DATABASE_URL during the build!
const prismaConfig: any = {
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL || "file:./dev.db",
  },
};

export default defineConfig(prismaConfig);