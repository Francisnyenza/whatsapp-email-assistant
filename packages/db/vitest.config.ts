import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', 'test/**/*.integration.spec.ts'],
    testTimeout: 15_000,
  },
});
