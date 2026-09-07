import { defineConfig } from 'vite';
export default defineConfig({
  build: {
    lib: { entry: 'src/dataCleaner/worker.ts', name: 'ChartBayDataCleanerWorker', fileName: () => 'quantbay.data-cleaner.worker.js', formats: ['iife'] },
    outDir: '../web/static/js', emptyOutDir: false,
  },
});
