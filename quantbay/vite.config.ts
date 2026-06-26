import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/main.ts',
      name: 'QuantBay',
      fileName: () => 'quantbay.bundle.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
