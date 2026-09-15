import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartPythonClient } from '../../src/chartpython/client';
import type { KernelRequest, KernelResponse } from '../../src/chartpython/protocol';
class WorkerStub {
  onmessage: ((event: MessageEvent<KernelResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: KernelRequest[] = [];
  terminated = false;
  postMessage(data: KernelRequest) { this.requests.push(data); }
  terminate() { this.terminated = true; }
  send(data: KernelResponse) { this.onmessage?.({ data } as MessageEvent<KernelResponse>); }
}
afterEach(() => { vi.useRealTimers(); });
describe('ChartPython client lifecycle', () => {
  function setup() {
    const workers: WorkerStub[] = [];
    const client = new ChartPythonClient(() => { const w = new WorkerStub(); workers.push(w); return w as unknown as Worker; });
    return { workers, client };
  }
  it('starts lazily, streams output and reuses the interpreter', async () => {
    const { client, workers } = setup();
    expect(workers).toHaveLength(0);
    const onOutput = vi.fn(), promise = client.execute('42', onOutput);
    const w = workers[0], id = w.requests[0].id;
    const output = { output_type: 'stream' as const, name: 'stdout' as const, text: '42' };
    w.send({ id, kind: 'output', output });
    w.send({ id, kind: 'done', result: { executionCount: 1, outputs: [output], status: 'ok' } });
    expect(onOutput).toHaveBeenCalledWith(output);
    expect((await promise).executionCount).toBe(1);
    const list = client.listFiles();
    expect(workers).toHaveLength(1);
    w.send({ id: w.requests[1].id, kind: 'done', result: [] });
    expect(await list).toEqual([]); client.dispose();
  });
  it('rejects concurrent execution and cancels by terminating Python', async () => {
    const { client, workers } = setup();
    const first = client.execute('while True: pass');
    await expect(client.execute('2')).rejects.toThrow('Esperá');
    client.restart(); await expect(first).rejects.toThrow('reinició');
    expect(workers[0].terminated).toBe(true);
    expect(client.busy).toBe(false);
    const second = client.execute('2');
    workers[0].send({ id: workers[1].requests[0].id, kind: 'error', code: 'worker-crashed', message: 'stale' });
    expect(client.busy).toBe(true);
    workers[1].send({ id: workers[1].requests[0].id, kind: 'done', result: { executionCount: 1, status: 'ok', outputs: [] } });
    await expect(second).resolves.toMatchObject({ status: 'ok' }); client.dispose();
  });
  it('times out the initial load and releases the worker', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup();
    const run = client.execute('while True: pass');
    const failure = expect(run).rejects.toThrow('120 segundos');
    await vi.advanceTimersByTimeAsync(120_000); await failure;
    expect(workers[0].terminated).toBe(true); expect(client.busy).toBe(false);
  });
  it('does not time out a cell once Python is executing', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup();
    const states: string[] = [];
    const stop = client.onStatus(s => states.push(s.state));
    const run = client.execute('while True: pass');
    workers[0].send({ id: workers[0].requests[0].id, kind: 'status', status: { state: 'ocupado' } });
    await vi.advanceTimersByTimeAsync(240_000);
    expect(workers[0].terminated).toBe(false); expect(client.busy).toBe(true);
    client.restart(); await expect(run).rejects.toMatchObject({ code: 'restarted' });
    expect(states).toEqual(['apagado', 'iniciando', 'ocupado', 'apagado']); stop();
  });
  it('settles crashes and permits a fresh load', async () => {
    const { client, workers } = setup();
    const run = client.warmup(); workers[0].onerror?.();
    await expect(run).rejects.toThrow('detuvo');
    const next = client.warmup(); workers[1].send({ id: workers[1].requests[0].id, kind: 'done', result: undefined });
    await next; client.dispose();
  });
  it('handles worker construction and message failures', async () => {
    const unavailable = new ChartPythonClient(() => { throw new Error('blocked'); });
    await expect(unavailable.warmup()).rejects.toThrow('blocked'); expect(unavailable.busy).toBe(false);
    const w = new WorkerStub(); w.postMessage = () => { throw new Error('clone failed'); };
    const client = new ChartPythonClient(() => w as unknown as Worker);
    await expect(client.warmup()).rejects.toThrow('clone failed');
    expect(client.busy).toBe(false); expect(w.terminated).toBe(true);
  });
});
