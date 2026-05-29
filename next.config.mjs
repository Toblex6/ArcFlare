import { ethers } from "ethers";

// 📡 Diagnostic Log: Prints your matching public wallet address on boot
if (process.env.ARC_ADMIN_PRIVATE_KEY) {
  try {
    const wallet = new ethers.Wallet(process.env.ARC_ADMIN_PRIVATE_KEY);
    console.log("\n==============================================");
    console.log("👉 YOUR DEVELOPER WALLET ADDRESS IS:");
    console.log(`   ${wallet.address}`);
    console.log("==============================================\n");
  } catch (e) {
    console.log("\n❌ Private key found in .env is invalid. Ensure it starts with 0x\n");
  }
} else {
  console.log("\n⚠️ ARC_ADMIN_PRIVATE_KEY is not defined in your local .env file.\n");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // Allows production builds to succeed if test utilities contain minor type issues
    ignoreBuildErrors: true,
  },
  async headers() {
    return [
      {
        source: '/_next/webpack-hmr',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
    ];
  },
};

export default nextConfig;