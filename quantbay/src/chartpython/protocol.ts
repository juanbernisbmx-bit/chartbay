/** Wire types use the Jupyter nbformat output shape, so export needs no translation. */
export type NotebookOutput =
  | { output_type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { output_type: 'execute_result'; execution_count: number; data: Record<string, string>; metadata: Record<string, unknown> }
  | { output_type: 'display_data'; data: Record<string, string>; metadata: Record<string, unknown> }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };
export interface ExecutionResult { executionCount: number; outputs: NotebookOutput[]; status: 'ok' | 'error' }
export interface KernelFile { name: string; size: number }
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_BYTES = 20 * 1024 * 1024;
export const MAX_CODE_BYTES = 100 * 1024;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const RUN_TIMEOUT_MS = 120_000;
export const WORKER_URL = '/static/js/chartpython.worker.js';
export type KernelRequest = { id: number } & (
  | { kind: 'warmup' | 'listFiles' }
  | { kind: 'execute'; code: string }
  | { kind: 'upload'; name: string; bytes: Uint8Array }
  | { kind: 'download'; name: string }
);
export type KernelResponse =
  | { id: number; kind: 'status'; status: KernelStatus }
  | { id: number; kind: 'output'; output: NotebookOutput }
  | { id: number; kind: 'done'; result: ExecutionResult | KernelFile[] | Uint8Array | string | undefined }
  | { id: number; kind: 'error'; message: string; code: KernelErrorCode };

export type KernelErrorCode = 'restarted' | 'worker-crashed' | 'busy' | 'load-failed' | 'too-large' | 'timeout' | 'invalid-file';
export class ChartPythonKernelError extends Error {
  constructor(public readonly code: KernelErrorCode, message: string) { super(message); this.name = 'ChartPythonKernelError'; }
}
export interface KernelStatus {
  state: 'apagado' | 'iniciando' | 'listo' | 'ocupado' | 'muerto';
  detail?: string;
  memoryBytes?: number;
}
