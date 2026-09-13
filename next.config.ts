import type { NextConfig } from 'next';
import { applicationSecurityHeaders } from './src/lib/application-security-policy';

const nextConfig: NextConfig = {
  // CORS-mode bootstrap requests retain their concrete origin even with the
  // product's no-referrer policy. The exact loopback host is dev-only.
  crossOrigin: 'anonymous',
  allowedDevOrigins: ['127.0.0.1'],
  async headers() {
    return [{ source: '/:path*', headers: [...applicationSecurityHeaders()] }];
  },
  images: {
    // The CRM has no next/image consumers. Keep generated image URLs direct;
    // middleware separately returns 404 for direct /_next/image requests.
    unoptimized: true,
  },
};

export default nextConfig;
