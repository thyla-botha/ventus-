import { defineConfig } from 'vitest/config';

// Shared vitest defaults for every workspace package. Per-package configs
// extend this and override `include` if they need to scope further.
export const baseConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10_000,
    pool: 'forks', // each test file gets its own process — isolates file I/O
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});

export default baseConfig;
