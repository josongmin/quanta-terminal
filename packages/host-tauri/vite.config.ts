import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env['TAURI_DEV_HOST'];

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'safari15',
    minify: 'esbuild',
    sourcemap: true,
    // Manual vendor chunking.
    //   - `react`: react + react-dom + scheduler, which rarely change between
    //     UI tweaks and so benefit from a long-lived hash.
    //   - `vendor`: everything else in node_modules.
    // With this, a small UI change only invalidates the app chunk, not the
    // react chunk — browsers keep it cached across deploys. (Pre-EPIC-I
    // a separate `xterm` chunk held ~200 kB of xterm.js; that dep is gone.)
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'react';
          }
          return 'vendor';
        },
      },
    },
    // Warning threshold tuned for the current vendor chunk sizes.
    chunkSizeWarningLimit: 500,
  },
}));
