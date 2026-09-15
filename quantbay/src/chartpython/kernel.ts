import { ChartPythonKernelError, type KernelRequest, type KernelResponse, type KernelStatus } from './protocol';
import { PythonRuntime, type PythonEngine } from './pythonRuntime';
const BASE = '/static/vendor/pyodide/0.26.4/';
const scope = globalThis as unknown as {
  importScripts(url: string): void;
  loadPyodide(options: { indexURL: string; lockFileURL: string; packages: string[]; stdin: () => undefined; stdout: () => void; stderr: () => void }): Promise<PythonEngine>;
  onmessage: (event: MessageEvent<KernelRequest>) => void;
  postMessage(message: KernelResponse): void;
};
let runtime: Promise<PythonRuntime> | null = null;
function getRuntime(status: (status: KernelStatus) => void): Promise<PythonRuntime> {
  if (!runtime) runtime = (async () => {
    status({ state: 'iniciando', detail: 'Cargando Python, pandas, NumPy, SciPy y statsmodels…' });
    scope.importScripts(BASE + 'pyodide.js');
    const py = await scope.loadPyodide({ indexURL: BASE, lockFileURL: BASE + 'pyodide-lock.json', packages: ['statsmodels'],
      stdin: () => undefined, stdout: () => {}, stderr: () => {} });
    const engine = new PythonRuntime(py);
    await engine.initialize();
    return engine;
  })().catch(error => { runtime = null; throw error; });
  return runtime;
}
let busy = false;
scope.onmessage = async ({ data }) => {
  if (busy) { scope.postMessage({ id: data.id, kind: 'error', code: 'busy', message: 'Python ya está ejecutando una operación.' }); return; }
  busy = true;
  let loaded = false;
  const status = (value: KernelStatus) => scope.postMessage({ id: data.id, kind: 'status', status: value });
  try {
    const engine = await getRuntime(status);
    loaded = true;
    status({ state: 'ocupado', detail: data.kind === 'execute' ? 'Ejecutando celda…' : 'Procesando…', memoryBytes: engine.memoryBytes });
    let result: Extract<KernelResponse, { kind: 'done' }>['result'];
    switch (data.kind) {
      case 'warmup': break;
      case 'execute': result = await engine.execute(data.code, output => scope.postMessage({ id: data.id, kind: 'output', output })); break;
      case 'upload': result = engine.upload(data.name, data.bytes); break;
      case 'listFiles': result = engine.listFiles(); break;
      case 'download': result = engine.download(data.name); break;
    }
    status({ state: 'listo', memoryBytes: engine.memoryBytes });
    scope.postMessage({ id: data.id, kind: 'done', result });
  } catch (error) {
    status({ state: loaded ? 'listo' : 'muerto' });
    scope.postMessage({ id: data.id, kind: 'error', code: error instanceof ChartPythonKernelError ? error.code : loaded ? 'invalid-file' : 'load-failed', message: error instanceof Error ? error.message : String(error) });
  } finally { busy = false; }
};
