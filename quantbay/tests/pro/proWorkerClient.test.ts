import { afterEach, describe, expect, it, vi } from 'vitest';

type WorkerMessageHandler = ((event: MessageEvent) => void) | null;

class FakeWorker {
  static last: FakeWorker | null = null;

  readonly url: string;
  onmessage: WorkerMessageHandler = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeWorker.last = this;
  }

  respond(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  FakeWorker.last = null;
});

describe('cliente del worker de Pro', () => {
  it('ejecuta OLS fuera del hilo principal y reenvía las fases', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { runProOlsInWorker, disposeProWorker } = await import(
      '../../src/pro/pyodide/proWorkerClient'
    );
    const phases: string[] = [];
    const promise = runProOlsInWorker({
      csvText: 'y,x\n1,2\n',
      yName: 'y',
      xNames: ['x'],
      form: 'lin-lin',
    }, phase => phases.push(phase));

    const fake = FakeWorker.last!;
    expect(fake.url).toBe('/static/js/quantbay.pro.worker.js');
    expect(fake.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ols', id: 1 }));
    fake.respond({ id: 1, kind: 'phase', phase: 'loading-pyodide' });
    fake.respond({
      id: 1,
      kind: 'ols-result',
      result: { ok: false, engine: 'pyodide', warnings: [], error: 'resultado controlado' },
    });

    await expect(promise).resolves.toMatchObject({ error: 'resultado controlado' });
    expect(phases).toEqual(['loading-pyodide']);
    disposeProWorker();
    expect(fake.terminate).toHaveBeenCalledOnce();
  });

  it('rechaza con mensaje controlado si el navegador no ofrece Web Workers', async () => {
    vi.stubGlobal('Worker', undefined);
    const { runProTimeSeriesInWorker } = await import('../../src/pro/pyodide/proWorkerClient');
    const result = await runProTimeSeriesInWorker({ values: [1, 2, 3], variableName: 'y' });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no permite Web Workers/i);
  });
});
