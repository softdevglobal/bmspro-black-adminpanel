import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  /* config options here */
  // Security: Limit RSC payload size to prevent DoS attacks (CVE-2025-55184)
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb', // Limit Server Action payload size
    },
  },
  // Use webpack explicitly (Turbopack doesn't support webpack configs)
  webpack: (config, { isServer, webpack }) => {
    // Exclude server-only modules from client bundles
    if (!isServer) {
      // Use NormalModuleReplacementPlugin to replace emailService with client stub
      const emailServiceStubPath = path.resolve(__dirname, 'lib/emailService.client.ts');
      const emailServiceRealPath = path.resolve(__dirname, 'lib/emailService.ts');
      
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/emailService$/,
          (resource: any) => {
            // Replace the real emailService with the client stub
            resource.request = emailServiceStubPath;
          }
        ),
        new webpack.NormalModuleReplacementPlugin(
          /^@\/lib\/emailService\.server$/,
          (resource: any) => {
            // Replace the server wrapper with the client stub
            resource.request = emailServiceStubPath;
          }
        )
      );
      
      // Also set alias as backup
      if (!config.resolve) {
        config.resolve = {};
      }
      if (!config.resolve.alias) {
        config.resolve.alias = {};
      }
      config.resolve.alias['@/lib/emailService'] = emailServiceStubPath;
      config.resolve.alias['@/lib/emailService.server'] = emailServiceStubPath;
    }
    return config;
  },
  // Add empty turbopack config to allow webpack usage
  turbopack: {},
  // Rewrite /book-now/* to the Booking Engine app (same domain strategy)
  // The booking engine has basePath: "/book-now" so we pass the full path through
  // Local dev: booking engine on localhost:3002
  // Production: set BOOKING_ENGINE_URL env var to the booking engine deployment URL
  async rewrites() {
    // Remove trailing slash to prevent double-slash in destination URL
    const bookingEngineUrl = (process.env.BOOKING_ENGINE_URL || "http://localhost:3002").replace(/\/+$/, "");
    return [
      {
        source: "/book-now/:path*",
        destination: `${bookingEngineUrl}/book-now/:path*`,
      },
    ];
  },
  // Security headers are now handled in middleware.ts with full CSP support
  // This section provides fallback headers for static assets
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // Prevent MIME type sniffing
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          // Prevent clickjacking
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          // Control referrer information
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          // Force HTTPS
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains; preload',
          },
          // Restrict browser features
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          // NOTE: X-XSS-Protection is intentionally removed - it's deprecated
          // CSP in middleware.ts is the modern replacement
        ],
      },
    ];
  },
};

export default nextConfig;
