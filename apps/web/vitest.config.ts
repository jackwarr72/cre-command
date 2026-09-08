import { fileURLToPath } from 'node:url';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Web component tests (jsdom + Testing Library).
 *
 * Run via `npm run test -w apps/web`; the root `test:unit` chains this after
 * the packages suite, so the CI unit gate covers the UI too. Source code is
 * typechecked separately by `tsc --noEmit` (Next tsconfig includes test/).
 */
const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(rootDir, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
  },
});