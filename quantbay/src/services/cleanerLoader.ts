/**
 * Loads a CSV through the WASM cleaner, falling back to PapaParse.
 *
 * The fallback is not decoration. The module is 160 KB that has to be fetched
 * and compiled, WebAssembly can be disabled by policy, and this path is new
 * where PapaParse has been carrying the app for a long time. Anything that
 * goes wrong here drops back to the old loader with a note in the run log,
 * rather than leaving the user with a dead upload button.
 */

import { parseCSVFile, type ParsedCSV } from '../csvParser';
import { bridgeCleanedTable, type BridgedDataset } from './cleanerBridge';
import { cleanCsv, loadCleaner, setCleanerBaseUrl } from '../../../cleaner/js/csvclean';
import {
  cleanCsvInWorker,
  createCleanerWorker,
  setCleanerWorker,
} from '../../../cleaner/js/workerClient';
import { calculateMemoryBudget, detectDeviceProfile } from '../../../cleaner/js/deviceProfiler';
import { preflight, type PreflightResult } from '../../../cleaner/js/preflight';
import type { MemoryBudget } from '../../../cleaner/js/deviceProfiler';

export interface LoadResult {
  data: ParsedCSV | BridgedDataset;
  /** Which path produced it. Surfaced in the UI, not just for debugging. */
  engine: 'wasm' | 'papaparse';
  budget: MemoryBudget;
  preflight?: PreflightResult;
  /** Lines for the run log. */
  notes: string[];
}

export interface LoadOptions {
  onProgress?: (fraction: number) => void;
  /** Forces the fallback. Used by tests and by a manual escape hatch. */
  disableWasm?: boolean;
  /** Keeps the work on the main thread. Only useful for debugging. */
  disableWorker?: boolean;
}

/** Where the worker bundle is served from. Built by `npm run build`. */
const WORKER_URL = '/static/js/quantbay.worker.js';

// Explicit on the main thread too. It happens to resolve correctly there, but
// relying on that would leave the two paths differing for no reason.
setCleanerBaseUrl('/static/wasm/');

function canUseWorker(): boolean {
  return typeof Worker !== 'undefined';
}

/** Detected once per page: the answer cannot change while the tab is open. */
let cachedBudget: MemoryBudget | null = null;

export function currentBudget(): MemoryBudget {
  if (!cachedBudget) cachedBudget = calculateMemoryBudget(detectDeviceProfile());
  return cachedBudget;
}

export async function loadCsv(file: File, options: LoadOptions = {}): Promise<LoadResult> {
  const budget = currentBudget();
  const notes: string[] = [];

  if (options.disableWasm) {
    const data = await parseCSVFile(file);
    return { data, engine: 'papaparse', budget, notes: ['Motor WASM desactivado.'] };
  }

  try {
    const plan = await preflight(file, budget);
    const mode = plan.recommendedMode;
    const recommendation = plan.recommendations[mode];

    notes.push(
      `Perfil del equipo: bloque de ${Math.round(budget.recommendedChunkBytes / 1048576)} MB, ` +
        `presupuesto de ${Math.round(budget.targetMemoryBytes / 1048576)} MB ` +
        `(confianza ${budget.confidence}).`
    );
    if (!plan.file.exact) {
      notes.push(`Filas estimadas: ~${plan.file.estimatedRows.toLocaleString('es-AR')}.`);
    }
    if (recommendation.status !== 'safe') {
      notes.push(recommendation.reason);
    }

    // The engine needs materialised columns, so a basic scan is not enough to
    // run a regression on. Preflight recommending it means the full clean was
    // judged too expensive — worth saying out loud rather than silently
    // downgrading into a dataset with no values in it.
    const runMode = mode === 'basic-scan' ? 'standard-clean' : mode;
    if (mode === 'basic-scan') {
      notes.push(
        'El archivo es grande para la memoria estimada. Se intenta la limpieza ' +
          'completa igual, y se aborta de forma limpia si no entra.'
      );
    }

    const runOptions = {
      mode: runMode,
      budget,
      estimatedMemoryBytes: plan.recommendations[runMode].estimatedMemoryBytes,
      onProgress: options.onProgress,
      onMemoryWarning: (message: string) => notes.push(message),
      // The engine keeps the arrays for the life of the session, and borrowed
      // views would be invalidated by the next upload.
      copy: true as const,
    };

    if (!options.disableWorker && canUseWorker()) {
      // Off the main thread the page keeps painting, and — less obviously —
      // terminating the worker afterwards is the only way to hand the WASM
      // heap back, since WASM memory never shrinks inside a live context.
      setCleanerWorker(createCleanerWorker(WORKER_URL));
      const table = await cleanCsvInWorker(file, { ...runOptions, terminateAfterRun: true });
      notes.push('Procesado en un worker; la interfaz no se bloqueó.');
      return { data: bridgeCleanedTable(table), engine: 'wasm', budget, preflight: plan, notes };
    }

    await loadCleaner();
    const table = await cleanCsv(file, runOptions);
    const data = bridgeCleanedTable(table);
    table.dispose();
    return { data, engine: 'wasm', budget, preflight: plan, notes };
  } catch (err) {
    notes.push(
      `El motor WASM no pudo procesar el archivo (${(err as Error).message}). ` +
        'Se usa el lector clásico.'
    );
    const data = await parseCSVFile(file);
    return { data, engine: 'papaparse', budget, notes };
  }
}
