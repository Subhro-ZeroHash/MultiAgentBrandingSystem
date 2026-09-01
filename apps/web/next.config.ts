import type { NextConfig } from 'next';

// Next's dev server needs 'unsafe-eval'/'unsafe-inline' on script-src for
// React Refresh — the production build doesn't, so this only relaxes CSP for
// local development, never for what actually ships.
const scriptSrc =
  process.env.NODE_ENV === 'production' ? "script-src 'self'" : "script-src 'self' 'unsafe-eval' 'unsafe-inline'";

// Same fallbacks src/lib/api.ts already uses — Next doesn't read the
// monorepo-root .env (only apps/web's own), so these vars are routinely unset
// here even though the app itself resolves to the same defaults at runtime.
const apiOrigins = [
  process.env.NEXT_PUBLIC_CONTENT_API_URL ?? 'http://localhost:4000',
  process.env.NEXT_PUBLIC_GEO_API_URL ?? 'http://localhost:4100',
].join(' ');

const csp = [
  "default-src 'self'",
  scriptSrc,
  // Next.js injects inline styles itself; there is no external stylesheet host to allow instead.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  `connect-src 'self' ${apiOrigins}`.trim(),
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship untranspiled ESM; let Next compile them.
  transpilePackages: ['@bmas/shared'],
  typedRoutes: true,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
