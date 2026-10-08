import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/review.entry.ts',
      name: 'ChartBayReview',
      fileName: () => 'chartbay.review.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
});
