/** @type {import('next').NextConfig} */
const nextConfig = {
  // This explicitly tells Turbopack where your project root is
  experimental: {
    turbopack: {
      root: process.cwd(),
    },
  },
  // Keep your headers if you still need them
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