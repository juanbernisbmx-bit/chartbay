// Minimal typing for the subset of the Pyodide API that the Pro POC uses.
// Pyodide is loaded at runtime from CDN, so there is no npm package to type against.

export type PyodideLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface PyodideGlobals {
  set(name: string, value: unknown): void;
}

export interface PyodideInterface {
  loadPackage(names: string | string[]): Promise<unknown>;
  runPythonAsync(code: string): Promise<unknown>;
  globals: PyodideGlobals;
}

export type LoadPyodideFn = (options: { indexURL: string }) => Promise<PyodideInterface>;
