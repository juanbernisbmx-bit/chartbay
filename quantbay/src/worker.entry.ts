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

import { setCleanerBaseUrl } from '../../cleaner/js/csvclean';
import '../../cleaner/js/csvclean.worker';

// Without this the module resolves csvclean.wasm next to the worker script
// instead of next to the glue, and gets a 404 page where the binary should be.
setCleanerBaseUrl('/static/wasm/');
