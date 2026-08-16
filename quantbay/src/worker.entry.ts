/**
 * Worker bundle entry point.
 *
 * Built separately from the main bundle (see vite.worker.config.ts) because the
 * app ships as a single IIFE and a worker needs its own top-level script.
 *
 * `importScripts` loads the Emscripten glue, which defines the CsvCleanModule
 * global that csvclean.ts expects. It runs before any module code calls it:
 * the module is only instantiated inside the message handler, never at import
 * time.
 */

declare function importScripts(...urls: string[]): void;

importScripts('/static/wasm/csvclean.js');

import '../../cleaner/js/csvclean.worker';
