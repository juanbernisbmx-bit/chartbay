import { ChartPythonKernelError, RUN_TIMEOUT_MS, WORKER_URL, MAX_CODE_BYTES, MAX_FILE_BYTES, type ExecutionResult, type KernelFile, type KernelRequest, type KernelResponse, type NotebookOutput, type KernelStatus, type KernelErrorCode } from './protocol';
import { filePath } from './pythonRuntime';
export { ChartPythonKernelError } from './protocol';
type Pending = { id: number; kind: KernelRequest['kind']; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; output?: (output: NotebookOutput) => void };
type Payload = KernelRequest extends infer R ? R extends { id: number } ? Omit<R, 'id'> : never : never;
/** One stateful interpreter per notebook page. Restart also cancels an infinite loop. */
export class ChartPythonClient {
  private worker: Worker | null = null;
  private pending: Pending | null = null;
  private sequence = 0;
  private status: KernelStatus = { state: 'apagado' };
  private listeners = new Set<(status: KernelStatus) => void>();
  constructor(private createWorker: () => Worker = () => new Worker(WORKER_URL), private timeout = RUN_TIMEOUT_MS) {}
  get busy(): boolean { return this.pending !== null; }
  onStatus(callback: (status: KernelStatus) => void): () => void {
    this.listeners.add(callback); callback({ ...this.status });
    return () => this.listeners.delete(callback);
  }
  private setStatus(status: KernelStatus): void {
    this.status = { ...status };
    for (const listener of this.listeners) listener({ ...status });
  }
  private request<T>(payload: Payload, output?: Pending['output']): Promise<T> {
    if (this.pending) return Promise.reject(new ChartPythonKernelError('busy', 'Esperá que termine la operación actual de Python.'));
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.onmessage = ({ data }: MessageEvent<KernelResponse>) => {
          if (worker !== this.worker || !this.pending || data.id !== this.pending.id) return;
          const request = this.pending;
          if (data.kind === 'status') {
            if (data.status.state === 'ocupado' && request.kind === 'execute') clearTimeout(request.timer);
            this.setStatus(data.status); return;
          }
          if (data.kind === 'output') { request.output?.(data.output); return; }
          clearTimeout(request.timer); this.pending = null;
          if (data.kind === 'error') request.reject(new ChartPythonKernelError(data.code, data.message));
          else request.resolve(data.result);
        };
        worker.onerror = () => { if (worker === this.worker) this.reset('worker-crashed', 'El proceso de Python se detuvo. Volvé a ejecutar las celdas para restaurar las variables.'); };
        worker.onmessageerror = () => { if (worker === this.worker) this.reset('worker-crashed', 'No se pudo leer la respuesta de Python. Volvé a ejecutar las celdas.'); };
      }
    } catch (error) { this.reset('load-failed'); return Promise.reject(new ChartPythonKernelError('load-failed', error instanceof Error ? error.message : String(error))); }
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending = { id, kind: payload.kind, resolve, reject, output, timer: setTimeout(() => this.reset('timeout', 'La preparación de Python o la operación de archivos superó 120 segundos. Se reinició el kernel; las celdas se conservan.'), this.timeout) };
      this.setStatus({ state: this.status.state === 'listo' ? 'ocupado' : 'iniciando', detail: 'Preparando Python…', memoryBytes: this.status.memoryBytes });
      try { this.worker!.postMessage({ ...payload, id }); }
      catch (error) { this.reset('worker-crashed', error instanceof Error ? error.message : String(error)); }
    });
  }
  warmup(): Promise<void> { return this.request({ kind: 'warmup' }); }
  execute(code: string, onOutput?: (output: NotebookOutput) => void): Promise<ExecutionResult> {
    if (new TextEncoder().encode(code).byteLength > MAX_CODE_BYTES) return Promise.reject(new ChartPythonKernelError('too-large', 'La celda supera 100 KiB de código. Dividila en varias celdas.'));
    return this.request({ kind: 'execute', code }, onOutput);
  }
  upload(name: string, bytes: Uint8Array): Promise<string> {
    try { filePath(name); } catch (error) { return Promise.reject(error); }
    if (bytes.byteLength > MAX_FILE_BYTES) return Promise.reject(new ChartPythonKernelError('too-large', 'Cada archivo puede ocupar hasta 10 MiB.'));
    return this.request({ kind: 'upload', name, bytes });
  }
  listFiles(): Promise<KernelFile[]> { return this.request({ kind: 'listFiles' }); }
  download(name: string): Promise<Uint8Array> {
    try { filePath(name); } catch (error) { return Promise.reject(error); }
    return this.request({ kind: 'download', name });
  }
  private reset(code: KernelErrorCode = 'restarted', message = 'Python se reinició. Se conservaron las celdas; las variables y archivos del kernel se borraron.'): void {
    this.worker?.terminate(); this.worker = null;
    const pending = this.pending; this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new ChartPythonKernelError(code, message)); }
    this.setStatus({ state: code === 'restarted' ? 'apagado' : 'muerto', detail: message });
  }
  restart(): void { this.reset(); }
  dispose(): void { this.reset('restarted', 'Se cerró el kernel de ChartPython.'); this.listeners.clear(); }
}
