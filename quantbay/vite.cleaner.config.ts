import { defineConfig } from 'vite';

/**
 * Tercer build: la página del Limpiador.
 *
 * Entrada propia porque no comparte nada con el motor econométrico, y así la
 * página carga solo el limpiador y su UI en vez de los 375 kB del bundle
 * principal.
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/cleaner.entry.ts',
      name: 'QuantBayCleaner',
      fileName: () => 'quantbay.cleaner.js',
      formats: ['iife'],
    },
    outDir: '../web/static/js',
    emptyOutDir: false,
  },
});
