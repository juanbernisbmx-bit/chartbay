import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/database.entry.ts',
      name: 'ChartBayDatabase',
      fileName: () => 'chartbay.database.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
});
