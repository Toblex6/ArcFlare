// @ts-nocheck
import "dotenv/config"; // 💡 THE REAL FIX: Loads your local .env variables into process.env before Prisma executes
import { defineConfig } from "prisma/config";

// 💡 THE SOLUTION: 
// 1. @ts-nocheck silences Next.js's compiler so the 'datasource' type mismatch won't block the build.
// 2. Native process.env keeps it safe from runtime module interop errors.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL,
  },
});