import { defineConfig } from 'vite';

/** El kernel corre en su propio worker: la URL la fija WORKER_URL en protocol.ts. */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/chartpython/kernel.ts',
      name: 'ChartPythonKernel',
      fileName: () => 'chartpython.worker.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
});
