/**
 * Worker entry point for the cleaner.
 *
 * Two reasons this exists, and the second is the less obvious one:
 *
 * 1. Processing a gigabyte of CSV on the main thread freezes the page for the
 *    whole run. Off-thread, the UI keeps painting progress.
 *
 * 2. WASM memory never shrinks. A module that has grown to 700 MB holds that
 *    for the lifetime of its context, no matter what is freed inside it.
 *    A worker *is* that context, so terminating it is the only way to actually
 *    return the memory — which matters as soon as a user cleans a second file.
 *
 * Columns are copied out and transferred, not borrowed: a view into the
 * worker's WASM memory would be meaningless on the main thread. The copies move
 * by transfer rather than structured clone, so crossing the boundary costs a
 * pointer hand-off rather than another full duplication.
 */

import { cleanCsv, type CleanColumn, type CleanOptions, type CleanReport } from './csvclean';

export interface WorkerRequest {
  id: number;
  file: Blob;
  /** Callbacks cannot cross a postMessage boundary, so they are stripped. */
  options: Omit<CleanOptions, 'onProgress' | 'onMemoryWarning' | 'budget'> & {
    budget?: CleanOptions['budget'];
  };
}

export type WorkerResponse =
  | { id: number; kind: 'progress'; fraction: number }
  | { id: number; kind: 'memory-warning'; message: string; heapBytes: number }
  | {
      id: number;
      kind: 'done';
      rows: number;
      columns: CleanColumn[];
      report: CleanReport;
    }
  | { id: number; kind: 'error'; message: string };

/** Buffers to hand over rather than clone. */
function transferables(columns: CleanColumn[]): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const column of columns) {
    buffers.push(column.mask.buffer as ArrayBuffer);
    if (column.kind === 'numeric') buffers.push(column.values.buffer as ArrayBuffer);
    else if (column.kind === 'date') buffers.push(column.days.buffer as ArrayBuffer);
    else if (column.kind === 'categorical') buffers.push(column.codes.buffer as ArrayBuffer);
  }
  // A borrowed view shares the WASM heap buffer; transferring that would
  // detach the module's own memory. Only owned copies are safe to move.
  return buffers.filter(buffer => buffer.byteLength > 0 && !isWasmHeap(buffer));
}

let wasmHeapBuffer: ArrayBuffer | null = null;
function isWasmHeap(buffer: ArrayBuffer): boolean {
  return wasmHeapBuffer !== null && buffer === wasmHeapBuffer;
}

const ctx = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { id, file, options } = event.data;
  try {
    const table = await cleanCsv(file, {
      ...options,
      // Always copy: the main thread cannot read this worker's WASM memory.
      copy: true,
      onProgress: fraction => ctx.postMessage({ id, kind: 'progress', fraction }),
      onMemoryWarning: (message, heapBytes) =>
        ctx.postMessage({ id, kind: 'memory-warning', message, heapBytes }),
    });

    ctx.postMessage(
      { id, kind: 'done', rows: table.rows, columns: table.columns, report: table.report },
      transferables(table.columns)
    );
    table.dispose();
  } catch (err) {
    ctx.postMessage({ id, kind: 'error', message: (err as Error).message });
  }
};

export {};
