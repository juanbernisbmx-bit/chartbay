import { defineConfig } from 'vite';

/**
 * Second build, for the Web Worker that runs the CSV cleaner off the main
 * thread. Separate because the app bundle is a single IIFE: a worker cannot
 * share it, it needs its own top-level script.
 *
 *   npm run build   builds both
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/worker.entry.ts',
      name: 'QuantBayWorker',
      fileName: () => 'quantbay.worker.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
});
