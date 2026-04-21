import { defineConfig } from 'vitest/config';

// Perf-budget tests under `src/__tests__/perf/` are opted-out of the
// default `test` run — they are long-running and measurement-sensitive,
// and are executed separately via `pnpm test:perf`
// (`tools/run-perf-budget.mjs`) which sets `VITEST_PERF=1`.
// Plan 0005 P0 Gate #7/#10.
const includePerf = process.env['VITEST_PERF'] === '1';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      ...(includePerf ? [] : ['src/__tests__/perf/**']),
    ],
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    css: false,
  },
  resolve: {
    alias: {
      '@quanta/host-common': new URL('../host-common/src/index.ts', import.meta.url).pathname,
    },
  },
});
