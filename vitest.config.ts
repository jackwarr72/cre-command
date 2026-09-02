import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/test/**/*.test.ts', 'packages/**/test/**/*.test.tsx', 'tests/**/*.test.ts'],
    setupFiles: [],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/**/src/**/*.ts'],
    },
  },
});