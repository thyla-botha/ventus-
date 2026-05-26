import type { NextConfig } from 'next';

const config: NextConfig = {
  experimental: {
    typedRoutes: true,
  },
  transpilePackages: ['@ventus/shared'],
};

export default config;
