import { defineConfig } from 'vitest/config';
import path from 'path';

// INTEGRATION tests: a real PostgreSQL (TEST_DATABASE_URL, see
// docs/USER_SIGNED_DEPLOYMENT.md) and, for the local-EVM suite, an in-process
// Hardhat chain. Run with `npm run test:integration`. Files run sequentially
// (one shared server, each suite creates and drops its own scratch database).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    include: ['lib/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
