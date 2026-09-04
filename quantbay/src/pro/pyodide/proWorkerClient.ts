import { proError, type PyodideOlsResult } from './proResultTypes';
import { tsError, type PyodideTimeSeriesInput, type PyodideTimeSeriesResult } from './proTimeSeriesResultTypes';
import type { PyodideOlsInput, PyodideOlsPhase } from './pythonOlsRunner';
import type { PyodideTimeSeriesPhase } from './pythonTimeSeriesRunner';
import type { ProWorkerRequest, ProWorkerResponse } from './proWorkerProtocol';
import type { ProWorkerWarmupResult } from './proWorkerProtocol';
import type { PyodideLoadPhase } from './pyodideTypes';

const WORKER_URL = '/static/js/quantbay.pro.worker.js';
const RUN_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 10 * 60_000;

type Pending = {
  kind: 'warmup' | 'ols' | 'timeseries';
  phase?: (phase: PyodideLoadPhase | PyodideOlsPhase | PyodideTimeSeriesPhase) => void;
  finish: (result: ProWorkerWarmupResult | PyodideOlsResult | PyodideTimeSeriesResult) => void;
  timer: ReturnType<typeof setTimeout>;
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function failure(
  kind: Pending['kind'],
  message: string
): ProWorkerWarmupResult | PyodideOlsResult | PyodideTimeSeriesResult {
  if (kind === 'warmup') return { ok: false, error: message };
  return kind === 'ols' ? proError(message) : tsError(message);
}

function clearIdleTimer(): void {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleDisposal(): void {
  clearIdleTimer();
  if (!worker || pending.size > 0) return;
  idleTimer = setTimeout(() => resetWorker(), IDLE_TIMEOUT_MS);
}

function failAll(message: string): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.finish(failure(request.kind, message));
  }
  pending.clear();
}

function resetWorker(message?: string): void {
  clearIdleTimer();
  worker?.terminate();
  worker = null;
  if (message) failAll(message);
}

function getWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined') return null;
  worker = new Worker(WORKER_URL);
  worker.onmessage = (event: MessageEvent<ProWorkerResponse>) => {
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    if (response.kind === 'phase') {
      request.phase?.(response.phase);
      return;
    }
    clearTimeout(request.timer);
    pending.delete(response.id);
    request.finish(response.result);
    scheduleIdleDisposal();
  };
  worker.onerror = () => {
    resetWorker('El worker de Pro se detuvo. Recargá la página e intentá de nuevo.');
  };
  return worker;
}

function requestWorker(
  request: ProWorkerRequest,
  phase: Pending['phase'],
  transfer: Transferable[] = []
): Promise<ProWorkerWarmupResult | PyodideOlsResult | PyodideTimeSeriesResult> {
  clearIdleTimer();
  const activeWorker = getWorker();
  if (!activeWorker) {
    return Promise.resolve(failure(
      request.kind,
      'Este navegador no permite Web Workers; Pro no se ejecuta en el hilo principal porque bloquearía la interfaz.'
    ));
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      const current = pending.get(request.id);
      if (!current) return;
      pending.delete(request.id);
      current.finish(failure(
        current.kind,
        'Pro superó los 120 segundos y se canceló para mantener la página utilizable. Probá un CSV más chico o Lite.'
      ));
      resetWorker('El worker de Pro se reinició después de superar el tiempo máximo.');
    }, RUN_TIMEOUT_MS);
    pending.set(request.id, { kind: request.kind, phase, finish: resolve, timer });
    activeWorker.postMessage(request, transfer);
  });
}

export async function warmupProWorker(
  onPhase?: (phase: PyodideLoadPhase) => void
): Promise<ProWorkerWarmupResult> {
  const id = nextId++;
  return requestWorker({ id, kind: 'warmup' }, onPhase as Pending['phase']) as Promise<ProWorkerWarmupResult>;
}

export async function runProOlsInWorker(
  input: PyodideOlsInput,
  onPhase?: (phase: PyodideOlsPhase) => void
): Promise<PyodideOlsResult> {
  const id = nextId++;
  const transfer: Transferable[] = [];
  if (input.numericData) {
    transfer.push(input.numericData.yValues.buffer, input.numericData.xValues.buffer);
  }
  return requestWorker({ id, kind: 'ols', input }, onPhase as Pending['phase'], transfer) as Promise<PyodideOlsResult>;
}

export async function runProTimeSeriesInWorker(
  input: PyodideTimeSeriesInput,
  onPhase?: (phase: PyodideTimeSeriesPhase) => void
): Promise<PyodideTimeSeriesResult> {
  const id = nextId++;
  const values = input.values instanceof Float64Array ? input.values : Float64Array.from(input.values);
  return requestWorker(
    { id, kind: 'timeseries', input: { ...input, values } },
    onPhase as Pending['phase'],
    [values.buffer]
  ) as Promise<PyodideTimeSeriesResult>;
}

export function hasActiveProAnalysis(): boolean {
  for (const request of pending.values()) {
    if (request.kind !== 'warmup') return true;
  }
  return false;
}

/** Libera el heap de Pyodide cuando el usuario vuelve a Lite. */
export function disposeProWorker(): void {
  resetWorker('La ejecución de Pro se canceló al cambiar a Lite.');
}
