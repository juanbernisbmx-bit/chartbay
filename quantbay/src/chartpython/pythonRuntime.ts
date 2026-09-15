import { ChartPythonKernelError, MAX_CODE_BYTES, MAX_FILE_BYTES, MAX_FILES_BYTES, MAX_OUTPUT_BYTES, type ExecutionResult, type KernelFile, type NotebookOutput } from './protocol';

interface Proxy { destroy(): void }
export interface PythonEngine {
  _module?: { HEAPU8: Uint8Array };
  runPython(code: string): unknown;
  runPythonAsync(code: string, options?: { globals: unknown; filename?: string }): Promise<unknown>;
  globals: { set(name: string, value: unknown): void; get(name: string): any; delete(name: string): void };
  FS: {
    mkdirTree(path: string): void;
    writeFile(path: string, bytes: Uint8Array): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    lstat(path: string): { mode: number; size: number };
    isFile(mode: number): boolean;
  };
}
// The wrapper namespace is separate from the notebook namespace. Assigning
// `json`, `sys`, `df` or even `display` in a cell cannot overwrite its helpers.
const BOOTSTRAP = String.raw`
import contextlib, io, json, traceback, warnings, linecache, re, base64, builtins
from pyodide.code import eval_code_async
with warnings.catch_warnings():
    warnings.filterwarnings('ignore', category=DeprecationWarning, message='.*Pyarrow.*')
    import pandas as pd
import os
os.chdir('/mnt/data')

class Stream(io.TextIOBase):
    def __init__(self, name, emit):
        self.name, self.emit = name, emit
    def writable(self):
        return True
    def write(self, text):
        if text:
            self.emit(json.dumps({'output_type': 'stream', 'name': self.name, 'text': text[:1048577]}, ensure_ascii=True))
        return len(text)
    def flush(self):
        pass

def plain(text):
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)

def bundle(value):
    data = {'text/plain': repr(value)[:262144]}
    html = getattr(value, '_repr_html_', None)
    if callable(html):
        try:
            rendered = html()
            if isinstance(rendered, str):
                data['text/html'] = rendered[:262144]
        except Exception:
            pass
    for mime, method in [('image/png', '_repr_png_'), ('image/svg+xml', '_repr_svg_')]:
        render = getattr(value, method, None)
        if callable(render):
            try:
                result = render()
                if mime == 'image/png' and isinstance(result, bytes):
                    result = base64.b64encode(result).decode('ascii')
                if isinstance(result, str) and len(result) <= 524288:
                    data[mime] = result
            except Exception:
                pass
    return data

def no_input(*args, **kwargs):
    raise RuntimeError('input() no está disponible en ChartPython. Asigná el valor en una celda o cargá un archivo.')

active_emit = None

def display(*values):
    if active_emit is not None:
        for value in values:
            active_emit(json.dumps({'output_type': 'display_data', 'data': bundle(value), 'metadata': {}}, ensure_ascii=True))

async def execute(code, count, emit):
    global active_emit
    active_emit = emit
    # Restore the display helper between executions; user variables persist.
    user['display'] = display
    filename = '<ChartPython cell %s>' % count
    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
    # Tracebacks for recent cells remain useful without keeping every edit forever.
    if count > 100:
        linecache.cache.pop('<ChartPython cell %s>' % (count - 100), None)
    with contextlib.redirect_stdout(Stream('stdout', emit)), contextlib.redirect_stderr(Stream('stderr', emit)):
        try:
            value = await eval_code_async(code, globals=user, filename=filename)
            if value is not None:
                user['___'], user['__'], user['_'] = user.get('__'), user.get('_'), value
                emit(json.dumps({'output_type': 'execute_result', 'execution_count': count, 'data': bundle(value), 'metadata': {}}, ensure_ascii=True))
            return 'ok'
        except BaseException as error:
            emit(json.dumps({'output_type': 'error', 'ename': type(error).__name__, 'evalue': str(error)[:65536],
                'traceback': [plain(line)[:65536] for line in (
                    traceback.format_list([frame for frame in traceback.extract_tb(error.__traceback__) if frame.filename.startswith('<ChartPython cell ')])
                    + traceback.format_exception_only(type(error), error))][-20:]}, ensure_ascii=True))
            return 'error'
        finally:
            active_emit = None

user_builtins = dict(vars(builtins))
user_builtins['input'] = no_input
user = {'__name__': '__main__', '__builtins__': user_builtins}
`;
const ROOT = '/mnt/data';
export function filePath(name: string): string {
  if (!name || name.length > 200 || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) {
    throw new ChartPythonKernelError('invalid-file', 'Usá un nombre de archivo de hasta 200 caracteres, sin carpetas ni caracteres de control.');
  }
  return `${ROOT}/${name}`;
}

export class PythonRuntime {
  private executionCount = 0;
  private namespace: Proxy;
  constructor(private py: PythonEngine) {
    py.FS.mkdirTree(ROOT);
    this.namespace = py.runPython('dict()') as Proxy;
  }
  async initialize(): Promise<void> {
    await this.py.runPythonAsync(BOOTSTRAP, { globals: this.namespace });
  }
  async execute(code: string, onOutput?: (output: NotebookOutput) => void): Promise<ExecutionResult> {
    if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) throw new ChartPythonKernelError('too-large', 'La celda supera 100 KiB de código. Dividila en varias celdas.');
    const outputs: NotebookOutput[] = [];
    const count = ++this.executionCount;
    let bytes = 0, events = 0, truncated = false;
    const emit = (json: string) => {
      if (truncated) return;
      const output = JSON.parse(json) as NotebookOutput;
      let size = new TextEncoder().encode(json).byteLength;
      if (bytes + size > MAX_OUTPUT_BYTES && (output.output_type === 'display_data' || output.output_type === 'execute_result')) {
        output.data = { 'text/plain': output.data['text/plain'] ?? '' };
        size = new TextEncoder().encode(JSON.stringify(output)).byteLength;
      }
      if (bytes + size > MAX_OUTPUT_BYTES || ++events > 2000) {
        // Keep a bounded prefix when a single print exceeds the budget.
        if (output.output_type === 'stream' && bytes < MAX_OUTPUT_BYTES && events <= 2000) {
          const prefix = output.text.slice(0, Math.max(0, Math.floor((MAX_OUTPUT_BYTES - bytes - 256) / 6)));
          if (prefix) { const partial = { ...output, text: prefix }; outputs.push(partial); onOutput?.({ ...partial }); }
        }
        truncated = true;
        const notice: NotebookOutput = { output_type: 'stream', name: 'stderr', text: '\n[Salida truncada: se alcanzó el límite de 1 MiB o 2000 fragmentos.]\n' };
        outputs.push(notice); onOutput?.(notice); return;
      }
      bytes += size;
      // Merge successive writes (print calls write twice), while streaming each
      // fragment to the UI. Every callback carries a fresh, immutable snapshot.
      const previous = outputs[outputs.length - 1];
      if (previous?.output_type === 'stream' && output.output_type === 'stream' && previous.name === output.name) previous.text += output.text;
      else outputs.push(structuredClone(output));
      onOutput?.(output);
    };
    const ns = this.namespace as Proxy & { set(name: string, value: unknown): void; delete(name: string): void };
    ns.set('_code', code); ns.set('_count', count); ns.set('_emit', emit);
    try {
      const status = await this.py.runPythonAsync('await execute(_code, _count, _emit)', { globals: this.namespace });
      return { executionCount: count, outputs, status: status === 'ok' ? 'ok' : 'error' };
    } finally {
      ns.delete('_code'); ns.delete('_count'); ns.delete('_emit');
    }
  }
  upload(name: string, bytes: Uint8Array): string {
    const path = filePath(name);
    if (!ArrayBuffer.isView(bytes) || bytes.BYTES_PER_ELEMENT !== 1 || bytes.byteLength > MAX_FILE_BYTES) throw new ChartPythonKernelError('too-large', 'Cada archivo puede ocupar hasta 10 MiB.');
    const files = this.listFiles();
    if (files.filter(f => f.name !== name).reduce((sum, f) => sum + f.size, bytes.byteLength) > MAX_FILES_BYTES) {
      throw new ChartPythonKernelError('too-large', 'Los archivos del kernel superan 20 MiB. Reiniciá Python para liberarlos.');
    }
    if (this.py.FS.readdir(ROOT).includes(name) && !this.py.FS.isFile(this.py.FS.lstat(path).mode)) throw new ChartPythonKernelError('invalid-file', 'El nombre pertenece a una carpeta o enlace. Elegí otro nombre.');
    this.py.FS.writeFile(path, bytes);
    return path;
  }
  listFiles(): KernelFile[] {
    return this.py.FS.readdir(ROOT).filter(n => n !== '.' && n !== '..').flatMap(name => {
      const stat = this.py.FS.lstat(filePath(name));
      return this.py.FS.isFile(stat.mode) ? [{ name, size: stat.size }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }
  download(name: string): Uint8Array {
    const path = filePath(name), stat = this.py.FS.lstat(path);
    if (!this.py.FS.isFile(stat.mode)) throw new ChartPythonKernelError('invalid-file', 'Solo se pueden descargar archivos, no carpetas o enlaces.');
    if (stat.size > MAX_FILE_BYTES) throw new ChartPythonKernelError('too-large', 'El archivo supera el límite de descarga de 10 MiB.');
    return this.py.FS.readFile(path);
  }
  get memoryBytes(): number | undefined { return this.py._module?.HEAPU8.byteLength; }
  dispose(): void { this.namespace.destroy(); }
}
