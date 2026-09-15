import { defineConfig } from 'vite';

/**
 * Página de ChartPython. Entrada propia: el notebook no comparte nada con el
 * motor econométrico ni con el limpiador, así que cada página baja sólo lo suyo.
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/chartpython/ui/main.ts',
      name: 'ChartPython',
      fileName: () => 'chartpython.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
});
