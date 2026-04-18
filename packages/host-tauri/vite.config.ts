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
    //   - `xterm`: xterm.js core + addons (the heaviest single dep).
    //   - `react`: react + react-dom + scheduler, which rarely change between
    //     UI tweaks and so benefit from a long-lived hash.
    //   - `vendor`: everything else in node_modules.
    // With this, a small UI change only invalidates the app chunk, not the
    // xterm / react chunks — browsers keep those cached across deploys.
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm/')) return 'xterm';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'react';
          }
          return 'vendor';
        },
      },
    },
    // Raise the "chunk too large" noise threshold; the xterm chunk is
    // inherently ~200 kB and the warning is purely informational.
    chunkSizeWarningLimit: 700,
  },
}));
