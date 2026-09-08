import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Live-service suites only (`*.integration.test.ts`): real PostgreSQL via
 * DATABASE_URL and real Redis via REDIS_URL. Suites self-apply migrations to
 * disposable databases. With CRE_ENFORCE_INTEGRATION=1 (CI) a missing service
 * fails the run instead of skipping it — see test-support/integration.ts.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/test/**/*.integration.test.ts', 'tests/**/*.integration.test.ts'],
    exclude: configDefaults.exclude,
    setupFiles: [],
  },
});