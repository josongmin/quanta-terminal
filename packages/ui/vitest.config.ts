import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
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
