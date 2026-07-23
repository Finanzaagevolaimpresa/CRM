import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  images: {
    // The CRM has no next/image consumers. Keep the optimizer endpoint closed
    // so the optional Sharp runtime is not reachable from HTTP requests.
    unoptimized: true,
  },
};

export default nextConfig;
