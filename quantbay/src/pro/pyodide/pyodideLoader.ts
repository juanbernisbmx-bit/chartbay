import type { LoadPyodideFn, PyodideInterface, PyodideLoadStatus } from './pyodideTypes';

// Pyodide is intentionally NOT bundled: the script is injected at runtime from
// the official CDN (same policy as papaparse/chart.js in quantbay.html), so the
// main bundle stays small and Lite users never download Python.
const PYODIDE_VERSION = '0.26.4';
const PYODIDE_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const PYODIDE_SCRIPT_URL = `${PYODIDE_BASE_URL}pyodide.js`;

let status: PyodideLoadStatus = 'idle';
let pyodidePromise: Promise<PyodideInterface> | null = null;

export function getPyodideLoadStatus(): PyodideLoadStatus {
  return status;
}

function injectPyodideScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PYODIDE_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Remove the failed tag so a retry (getPyodide() after an error resets
      // the cached promise) doesn't pile up orphan <script> tags in <head>.
      script.remove();
      reject(new Error(`No se pudo descargar Pyodide desde ${PYODIDE_SCRIPT_URL}. Revisá la conexión a internet.`));
    };
    document.head.appendChild(script);
  });
}

async function loadPyodideOnce(): Promise<PyodideInterface> {
  const globalScope = globalThis as unknown as { loadPyodide?: LoadPyodideFn };
  if (typeof globalScope.loadPyodide !== 'function') {
    await injectPyodideScript();
  }
  if (typeof globalScope.loadPyodide !== 'function') {
    throw new Error('El script de Pyodide cargó pero loadPyodide no está disponible. Recargá la página e intentá de nuevo.');
  }
  return globalScope.loadPyodide({ indexURL: PYODIDE_BASE_URL });
}

/**
 * Returns the shared Pyodide instance, loading it from CDN on first use.
 * The promise is cached so Pyodide initializes at most once per page; a failed
 * load resets the cache so the user can retry.
 */
export async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    status = 'loading';
    pyodidePromise = loadPyodideOnce().then(
      pyodide => {
        status = 'ready';
        return pyodide;
      },
      err => {
        status = 'error';
        pyodidePromise = null;
        throw err;
      }
    );
  }
  return pyodidePromise;
}
