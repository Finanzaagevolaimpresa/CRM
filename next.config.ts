import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    // The CRM has no next/image consumers. Keep generated image URLs direct;
    // middleware separately returns 404 for direct /_next/image requests.
    unoptimized: true,
  },
};

export default nextConfig;
