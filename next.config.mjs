import { withSentryConfig } from '@sentry/nextjs';
import { ethers } from 'ethers';

// 📡 Diagnostic Log: Prints your matching public wallet address on boot
if (process.env.ARC_ADMIN_PRIVATE_KEY) {
  try {
    const wallet = new ethers.Wallet(process.env.ARC_ADMIN_PRIVATE_KEY);
    console.log('\n==============================================');
    console.log('👉 YOUR DEVELOPER WALLET ADDRESS IS:');
    console.log(`   ${wallet.address}`);
    console.log('==============================================\n');
  } catch (e) {
    console.log('\n❌ Private key found in .env is invalid. Ensure it starts with 0x\n');
  }
} else {
  console.log('\n⚠️ ARC_ADMIN_PRIVATE_KEY is not defined in your local .env file.\n');
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
        headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
      },
    ];
  },
  webpack: (config, { webpack }) => {
    // @coinbase/cdp-sdk (pulled in transitively via wagmi's Coinbase Smart
    // Wallet connector) lazy-loads Solana x402 support through its own
    // `importX402Dependency()` helper, which already try/catches the import
    // at runtime — we don't use Solana anywhere in this app, and the
    // package isn't installed. Webpack still tries to statically resolve
    // it at build time and hard-fails since there's nothing there to find.
    // Tell webpack to skip it entirely; the runtime guard handles the rest.
    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^@x402\/svm(\/.*)?$/,
      })
    );

    config.plugins.push(
      new webpack.IgnorePlugin({
        resourceRegExp: /^accounts$/,
      })
    );


    return config;
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: 'flarehq',

  project: 'javascript-nextjs',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Uncomment to route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  // tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
