import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship untranspiled ESM; let Next compile them.
  transpilePackages: ['@bmas/shared'],
  typedRoutes: true,
};

export default nextConfig;
