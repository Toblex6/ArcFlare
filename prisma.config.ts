// prisma.config.ts

// 💡 THE DEFINITIVE FIX: Inline object literal with zero external imports.
// This perfectly satisfies Prisma's static text parser without requiring devDependencies.
export default {
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env.DATABASE_URL || "file:./dev.db",
  },
};