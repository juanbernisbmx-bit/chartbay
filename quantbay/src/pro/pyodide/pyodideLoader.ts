import type {
  LoadPyodideFn,
  PyodideInterface,
  PyodideLoadPhase,
  PyodideLoadStatus,
} from './pyodideTypes';

// Pyodide and the exact statsmodels dependency closure are vendored under the
// same origin. Lite users still never download them: the dedicated Pro worker
// requests this directory only after the user selects Pro.
const PYODIDE_VERSION = '0.26.4';
const PYODIDE_BASE_URL = `/static/vendor/pyodide/${PYODIDE_VERSION}/`;
const PYODIDE_SCRIPT_URL = `${PYODIDE_BASE_URL}pyodide.js`;
const PYODIDE_LOCK_URL = `${PYODIDE_BASE_URL}pyodide-lock.json`;
const PYODIDE_PACKAGES = ['statsmodels'];

let status: PyodideLoadStatus = 'idle';
let currentPhase: PyodideLoadPhase | null = null;
let pyodidePromise: Promise<PyodideInterface> | null = null;

export function getPyodideLoadStatus(): PyodideLoadStatus {
  return status;
}

function injectPyodideScript(): Promise<void> {
  const workerScope = globalThis as typeof globalThis & {
    importScripts?: (...urls: string[]) => void;
  };
  if (typeof document === 'undefined' && typeof workerScope.importScripts === 'function') {
    try {
      workerScope.importScripts(PYODIDE_SCRIPT_URL);
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(new Error(
        `No se pudo cargar Pyodide desde ChartBay (${PYODIDE_SCRIPT_URL}): ${err instanceof Error ? err.message : String(err)}`
      ));
    }
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = PYODIDE_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      // Remove the failed tag so a retry (getPyodide() after an error resets
      // the cached promise) doesn't pile up orphan <script> tags in <head>.
      script.remove();
      reject(new Error(`No se pudo cargar Pyodide desde ChartBay (${PYODIDE_SCRIPT_URL}). Recargá la página e intentá de nuevo.`));
    };
    document.head.appendChild(script);
  });
}

async function loadPyodideOnce(onPhase?: (phase: PyodideLoadPhase) => void): Promise<PyodideInterface> {
  currentPhase = 'loading-pyodide';
  onPhase?.(currentPhase);
  const globalScope = globalThis as unknown as { loadPyodide?: LoadPyodideFn };
  if (typeof globalScope.loadPyodide !== 'function') {
    await injectPyodideScript();
  }
  if (typeof globalScope.loadPyodide !== 'function') {
    throw new Error('El script de Pyodide cargó pero loadPyodide no está disponible. Recargá la página e intentá de nuevo.');
  }
  // `packages` permite que Pyodide resuelva y descargue el cierre de
  // statsmodels mientras inicializa CPython, en vez de esperar una segunda
  // ronda posterior con loadPackage().
  currentPhase = 'loading-packages';
  onPhase?.(currentPhase);
  return globalScope.loadPyodide({
    indexURL: PYODIDE_BASE_URL,
    lockFileURL: PYODIDE_LOCK_URL,
    packages: PYODIDE_PACKAGES,
  });
}

/**
 * Returns the shared Pyodide instance, loading it from ChartBay on first use.
 * The promise is cached so Pyodide initializes at most once per page; a failed
 * load resets the cache so the user can retry.
 */
export async function getPyodide(
  onPhase?: (phase: PyodideLoadPhase) => void
): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    status = 'loading';
    pyodidePromise = loadPyodideOnce(onPhase).then(
      pyodide => {
        status = 'ready';
        currentPhase = null;
        return pyodide;
      },
      err => {
        status = 'error';
        currentPhase = null;
        pyodidePromise = null;
        throw err;
      }
    );
  } else if (status === 'loading' && currentPhase) {
    onPhase?.(currentPhase);
  }
  return pyodidePromise;
}
