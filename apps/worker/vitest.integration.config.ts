import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.spec.ts'],
    testTimeout: 30_000,
    // Shared database state; parallel files would fight over it.
    fileParallelism: false,
  },
});
