import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/pro.worker.entry.ts',
      name: 'ChartBayProWorker',
      fileName: () => 'quantbay.pro.worker.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
});
