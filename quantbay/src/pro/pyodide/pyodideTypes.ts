// Minimal typing for the subset of the vendored Pyodide API that Pro uses.

export type PyodideLoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type PyodideLoadPhase = 'loading-pyodide' | 'loading-packages';

export interface PyodideGlobals {
  set(name: string, value: unknown): void;
}

export interface PyodideInterface {
  loadPackage(names: string | string[]): Promise<unknown>;
  runPythonAsync(code: string): Promise<unknown>;
  globals: PyodideGlobals;
}

export type LoadPyodideFn = (options: {
  indexURL: string;
  lockFileURL: string;
  packages: string[];
}) => Promise<PyodideInterface>;
