import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PyodideInterface } from '../../src/pro/pyodide/pyodideTypes';

type LoaderModule = typeof import('../../src/pro/pyodide/pyodideLoader');

function setGlobalLoadPyodide(fn: unknown): void {
  (globalThis as unknown as { loadPyodide?: unknown }).loadPyodide = fn;
}

function clearGlobalLoadPyodide(): void {
  delete (globalThis as unknown as { loadPyodide?: unknown }).loadPyodide;
}

// Loosely typed on purpose: vi.spyOn's inferred generic for a native DOM method
// overload doesn't widen cleanly to a reusable helper signature under strict mode.
function getAppendedScript(spy: { mock: { calls: unknown[][] } }, index = 0): HTMLScriptElement {
  const call = spy.mock.calls[index];
  return call[0] as HTMLScriptElement;
}

describe('pyodideLoader', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let appendChildSpy: any;

  beforeEach(() => {
    vi.resetModules();
    clearGlobalLoadPyodide();
    appendChildSpy = vi.spyOn(document.head, 'appendChild');
  });

  afterEach(() => {
    appendChildSpy.mockRestore();
    clearGlobalLoadPyodide();
  });

  async function loadModule(): Promise<LoaderModule> {
    return import('../../src/pro/pyodide/pyodideLoader');
  }

  it('starts idle and moves to loading as soon as getPyodide is called', async () => {
    const { getPyodide, getPyodideLoadStatus } = await loadModule();
    expect(getPyodideLoadStatus()).toBe('idle');

    const promise = getPyodide();
    expect(getPyodideLoadStatus()).toBe('loading');

    // The real CDN script defines window.loadPyodide as a side effect of loading,
    // then fires onload — so the global is only set once the script "finishes".
    const fakeInstance = {} as PyodideInterface;
    setGlobalLoadPyodide(vi.fn().mockResolvedValue(fakeInstance));
    const script = getAppendedScript(appendChildSpy);
    script.onload?.(new Event('load'));
    await promise;
    expect(getPyodideLoadStatus()).toBe('ready');
  });

  it('injects the CDN script tag and resolves once loadPyodide becomes available', async () => {
    const { getPyodide } = await loadModule();
    const fakeInstance = { marker: 'pyodide' } as unknown as PyodideInterface;
    const fakeLoadPyodide = vi.fn().mockResolvedValue(fakeInstance);

    const promise = getPyodide();
    const script = getAppendedScript(appendChildSpy);
    expect(script.src).toContain('pyodide.js');

    setGlobalLoadPyodide(fakeLoadPyodide);
    script.onload?.(new Event('load'));

    const instance = await promise;
    expect(instance).toBe(fakeInstance);
    expect(fakeLoadPyodide).toHaveBeenCalledWith({ indexURL: expect.stringContaining('pyodide') });
  });

  it('caches the promise: a second call does not inject another script tag', async () => {
    const { getPyodide } = await loadModule();

    const p1 = getPyodide();
    const script = getAppendedScript(appendChildSpy);
    setGlobalLoadPyodide(vi.fn().mockResolvedValue({} as PyodideInterface));
    script.onload?.(new Event('load'));
    await p1;

    appendChildSpy.mockClear();
    await getPyodide();
    expect(appendChildSpy).not.toHaveBeenCalled();
  });

  it('skips script injection when loadPyodide is already a global function', async () => {
    setGlobalLoadPyodide(vi.fn().mockResolvedValue({ already: true } as unknown as PyodideInterface));
    const { getPyodide } = await loadModule();

    const instance = await getPyodide();
    expect(instance).toEqual({ already: true });
    expect(appendChildSpy).not.toHaveBeenCalled();
  });

  it('removes the failed script tag and resets to error status on load failure', async () => {
    const { getPyodide, getPyodideLoadStatus } = await loadModule();

    const p1 = getPyodide();
    const script = getAppendedScript(appendChildSpy);
    const removeSpy = vi.spyOn(script, 'remove');
    script.onerror?.(new Event('error'));

    await expect(p1).rejects.toThrow(/No se pudo descargar Pyodide/);
    expect(getPyodideLoadStatus()).toBe('error');
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it('allows retrying after a failed load without leaving orphan script tags', async () => {
    const { getPyodide, getPyodideLoadStatus } = await loadModule();

    const p1 = getPyodide();
    const firstScript = getAppendedScript(appendChildSpy);
    firstScript.onerror?.(new Event('error'));
    await expect(p1).rejects.toThrow();
    expect(document.head.contains(firstScript)).toBe(false);

    appendChildSpy.mockClear();
    const p2 = getPyodide();
    expect(appendChildSpy).toHaveBeenCalledTimes(1);
    const secondScript = getAppendedScript(appendChildSpy);
    setGlobalLoadPyodide(vi.fn().mockResolvedValue({ retried: true } as unknown as PyodideInterface));
    secondScript.onload?.(new Event('load'));

    const instance = await p2;
    expect(instance).toEqual({ retried: true });
    expect(getPyodideLoadStatus()).toBe('ready');
  });

  it('rejects with a clear message if the script loads but loadPyodide is still missing', async () => {
    const { getPyodide } = await loadModule();
    const promise = getPyodide();
    const script = getAppendedScript(appendChildSpy);
    // Simulate a script that "loaded" but never defined the global (corrupted CDN response).
    script.onload?.(new Event('load'));
    await expect(promise).rejects.toThrow(/loadPyodide no está disponible/);
  });
});
