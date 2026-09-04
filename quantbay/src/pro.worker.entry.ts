import { runPyodideOls } from './pro/pyodide/pythonOlsRunner';
import { runPyodideTimeSeries } from './pro/pyodide/pythonTimeSeriesRunner';
import { proError } from './pro/pyodide/proResultTypes';
import { tsError } from './pro/pyodide/proTimeSeriesResultTypes';
import type { ProWorkerRequest, ProWorkerResponse } from './pro/pyodide/proWorkerProtocol';
import { getPyodide } from './pro/pyodide/pyodideLoader';

function send(message: ProWorkerResponse): void {
  postMessage(message);
}

async function handleRequest(request: ProWorkerRequest): Promise<void> {
  try {
    if (request.kind === 'warmup') {
      await getPyodide(phase => {
        send({ id: request.id, kind: 'phase', phase });
      });
      send({ id: request.id, kind: 'warmup-result', result: { ok: true } });
      return;
    }
    if (request.kind === 'ols') {
      const result = await runPyodideOls(request.input, phase => {
        send({ id: request.id, kind: 'phase', phase });
      });
      send({ id: request.id, kind: 'ols-result', result });
      return;
    }
    const result = await runPyodideTimeSeries(request.input, phase => {
      send({ id: request.id, kind: 'phase', phase });
    });
    send({ id: request.id, kind: 'timeseries-result', result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (request.kind === 'warmup') {
      send({ id: request.id, kind: 'warmup-result', result: { ok: false, error: message } });
    } else if (request.kind === 'ols') {
      send({ id: request.id, kind: 'ols-result', result: proError(`El worker de Pro falló: ${message}`) });
    } else {
      send({ id: request.id, kind: 'timeseries-result', result: tsError(`El worker de Pro falló: ${message}`) });
    }
  }
}

// Pyodide mantiene un único intérprete y los runners usan variables globales
// temporales. Serializar acá protege también el caso regresión + serie de
// tiempo, que no queda cubierto por los guards independientes de la interfaz.
let requestQueue: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<ProWorkerRequest>) => {
  const request = event.data;
  requestQueue = requestQueue.then(() => handleRequest(request));
};
