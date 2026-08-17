import type { NextConfig } from 'next';
import { applicationSecurityHeaders } from './src/lib/application-security-policy';

const nextConfig: NextConfig = {
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
