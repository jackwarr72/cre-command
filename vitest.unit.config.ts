import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Fast suite: every test except live-service integration files.
 * Requires no PostgreSQL/Redis — safe for every commit, editor run, and CI's
 * pre-service phase. See vitest.integration.config.ts for the service suites.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'packages/**/test/**/*.test.tsx', 'tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/**/src/**/*.ts'],
    },
  },
});