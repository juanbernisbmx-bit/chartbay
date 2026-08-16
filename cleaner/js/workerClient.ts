/**
 * Main-thread side of the worker. Same call shape as `cleanCsv`, but the file
 * is processed off-thread and the memory is genuinely reclaimable.
 *
 * The profiling stays here on the main thread — `navigator.deviceMemory` and
 * `performance.memory` are available in workers too, but the UI needs the
 * profile anyway, and one detection per page is enough. The resulting budget is
 * plain data, so it crosses to the worker as a structured clone.
 */

import type { CleanColumn, CleanOptions, CleanReport } from './csvclean';
import type { WorkerRequest, WorkerResponse } from './csvclean.worker';

export interface WorkerTable {
  rows: number;
  columns: CleanColumn[];
  report: CleanReport;
  column(name: string): CleanColumn | undefined;
}

export interface WorkerRunOptions extends CleanOptions {
  /**
   * Terminate the worker once the run finishes. This is the only way to hand
   * WASM memory back to the browser — inside a live context it never shrinks —
   * at the cost of reloading the module for the next file (~160 KB, cached).
   * Default true, because holding 700 MB between files is the worse trade.
   */
  terminateAfterRun?: boolean;
}

let worker: Worker | null = null;
let nextId = 1;

/**
 * Creates the worker. Kept in a function so callers can supply their own URL:
 * bundlers each have their own idea of how a worker should be referenced, and
 * hard-coding one would tie this file to a build system.
 */
export function createCleanerWorker(url: URL | string, type: WorkerType = 'classic'): Worker {
  // Classic by default: the shipped worker bundle is an IIFE that pulls the
  // Emscripten glue in with importScripts, which module workers do not have.
  return new Worker(url, type === 'module' ? { type: 'module' } : undefined);
}

export function setCleanerWorker(instance: Worker | null): void {
  if (worker && worker !== instance) worker.terminate();
  worker = instance;
}

export function terminateCleanerWorker(): void {
  worker?.terminate();
  worker = null;
}

/**
 * Runs the cleaner in the worker set by `setCleanerWorker`.
 *
 * Throws if no worker has been installed rather than guessing a module URL,
 * which cannot be done portably across bundlers.
 */
export function cleanCsvInWorker(
  file: Blob,
  options: WorkerRunOptions = {}
): Promise<WorkerTable> {
  const active = worker;
  if (!active) {
    throw new Error(
      'No hay worker instalado. Llamá a setCleanerWorker(createCleanerWorker(url)) primero.'
    );
  }

  const id = nextId++;
  const { onProgress, onMemoryWarning, terminateAfterRun = true, ...rest } = options;

  return new Promise<WorkerTable>((resolve, reject) => {
    const onMessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (message.id !== id) return;

      switch (message.kind) {
        case 'progress':
          onProgress?.(message.fraction);
          return;
        case 'memory-warning':
          onMemoryWarning?.(message.message, message.heapBytes);
          return;
        case 'done': {
          cleanup();
          const byName = new Map(message.columns.map(c => [c.name, c] as const));
          resolve({
            rows: message.rows,
            columns: message.columns,
            report: message.report,
            column: name => byName.get(name),
          });
          return;
        }
        case 'error':
          cleanup();
          reject(new Error(message.message));
          return;
      }
    };

    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || 'El worker falló.'));
    };

    const cleanup = () => {
      active.removeEventListener('message', onMessage as EventListener);
      active.removeEventListener('error', onError as EventListener);
      if (terminateAfterRun) {
        active.terminate();
        if (worker === active) worker = null;
      }
    };

    active.addEventListener('message', onMessage as EventListener);
    active.addEventListener('error', onError as EventListener);

    const request: WorkerRequest = { id, file, options: rest };
    active.postMessage(request);
  });
}
