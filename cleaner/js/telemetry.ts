/**
 * Local measurement, so the limits in processingLimits.ts can eventually be
 * calibrated against real runs instead of one benchmark machine.
 *
 * Nothing here leaves the browser. There is no network call in this file and
 * there should never be one: the entire premise of doing this in WebAssembly is
 * that the data never leaves the user's machine, and telemetry about that data
 * — row counts, column names, file sizes — would leak the shape of it.
 * Everything lives in memory for the session and is discarded on reload.
 */

import { MEMORY_WARNING_FRACTION } from './processingLimits';
import type { ProcessingMode } from './preflight';

export interface RunRecord {
  mode: ProcessingMode;
  startedAt: number;
  elapsedMs: number;
  bytesProcessed: number;
  bytesPerSecond: number;
  rowsProcessed: number;
  /** Heap when the run finished. */
  finalHeapBytes: number;
  /** Largest heap seen during the run. */
  peakHeapBytes: number;
  /** What preflight predicted, when it was run. Lets us score the model. */
  estimatedMemoryBytes?: number;
  /** peak / estimate. Above 1 means the estimate was optimistic. */
  estimateRatio?: number;
  aborted: boolean;
  abortReason?: string;
}

export class SessionTelemetry {
  private runs: RunRecord[] = [];

  record(run: RunRecord): void {
    this.runs.push(run);
  }

  all(): readonly RunRecord[] {
    return this.runs;
  }

  clear(): void {
    this.runs = [];
  }

  /**
   * How well the memory model is doing this session. The point of collecting
   * anything: if estimates run consistently low, the constants need raising.
   */
  summary(): {
    runs: number;
    totalBytes: number;
    meanBytesPerSecond: number;
    peakHeapBytes: number;
    estimateRatios: number[];
  } {
    const withEstimates = this.runs.filter(r => r.estimateRatio !== undefined);
    const totalBytes = this.runs.reduce((sum, r) => sum + r.bytesProcessed, 0);
    const totalMs = this.runs.reduce((sum, r) => sum + r.elapsedMs, 0);
    return {
      runs: this.runs.length,
      totalBytes,
      meanBytesPerSecond: totalMs > 0 ? (totalBytes / totalMs) * 1000 : 0,
      peakHeapBytes: this.runs.reduce((max, r) => Math.max(max, r.peakHeapBytes), 0),
      estimateRatios: withEstimates.map(r => r.estimateRatio as number),
    };
  }
}

/** One shared session log, since there is one WASM module per page. */
export const sessionTelemetry = new SessionTelemetry();

// ── Memory monitor ────────────────────────────────────────────────────────────

export type MemoryEvent =
  | { kind: 'ok'; heapBytes: number }
  | { kind: 'warning'; heapBytes: number; message: string }
  | { kind: 'abort'; heapBytes: number; message: string };

/**
 * Watches the real heap while a file is being processed.
 *
 * This is the part that does not trust the estimates. Preflight guesses from a
 * 256 KB sample; a file whose tail is nothing like its head will blow past the
 * projection. `cbc_heap_bytes()` reports the actual WASM linear memory, which
 * is the one number in this whole system that is measured rather than inferred.
 *
 * Aborting between chunks is clean by construction: the parser owns no borrowed
 * pointers across `cbc_feed` calls, the input file is untouched, and dropping
 * the handle frees everything. The alternative — pressing on and having the
 * browser kill the tab — loses the run anyway and takes the page with it.
 */
export class MemoryMonitor {
  private peak = 0;
  private warned = false;

  constructor(
    private readonly targetBytes: number,
    private readonly maxBytes: number
  ) {}

  check(heapBytes: number): MemoryEvent {
    if (heapBytes > this.peak) this.peak = heapBytes;

    if (heapBytes >= this.maxBytes) {
      return {
        kind: 'abort',
        heapBytes,
        message:
          `El procesamiento usó ${Math.round(heapBytes / 1048576)} MB, por encima del ` +
          `máximo de ${Math.round(this.maxBytes / 1048576)} MB. Se detuvo antes de ` +
          'quedarse sin memoria. El archivo original está intacto; probá con escaneo ' +
          'básico o desactivá la detección de duplicados.',
      };
    }

    if (!this.warned && heapBytes >= this.targetBytes * MEMORY_WARNING_FRACTION) {
      this.warned = true;
      return {
        kind: 'warning',
        heapBytes,
        message:
          `El uso de memoria (${Math.round(heapBytes / 1048576)} MB) se acercó al ` +
          `presupuesto de ${Math.round(this.targetBytes / 1048576)} MB.`,
      };
    }

    return { kind: 'ok', heapBytes };
  }

  peakBytes(): number {
    return this.peak;
  }
}
