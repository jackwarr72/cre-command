/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@cre/shared', '@cre/db', '@cre/crawler', '@cre/adapters'],
  async rewrites() {
    // Single-origin UX: /api/* is proxied to the REST API.
    const apiOrigin = process.env.API_ORIGIN || 'http://localhost:4000';
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;