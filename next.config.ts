import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Tells the compiler to look up Prisma externally instead of trying to bundle it raw
  serverExternalPackages: ['@prisma/client'],
};

export default nextConfig;
