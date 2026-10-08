// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { putHandoff, takeHandoff, takeHandoffDataset, hasHandoff, type DatabaseHandoff } from '../../src/services/datasetHandoff';

describe('database handoff', () => {
  it('commits the CSV and provenance together, then consumes both once', async () => {
    const metadata: DatabaseHandoff = { source: 'database', mode: 'regression', yName: 'y', xNames: ['x'],
      releaseId: 'pilot-test', preparedAt: '2026-10-05', rows: 1, start: '2020-01-01', end: '2020-01-01',
      excludedMonths: [], incompleteMonths: [], series: [{ id: 'ipc_ng_nacional', name: 'IPC', column: 'ipc', unit: 'Índice',
        transform: 'Nivel original', lag: 0, source: 'INDEC', sourceUrl: 'https://www.indec.gob.ar/', originalUrl: null, sha256: null,
        retrievedAt: '2026-10-05T18:56:59+00:00', publishedAt: '2026-09-10T18:52:05+00:00', normalizationNotes: [] }] };
    await putHandoff('conjunto.csv', 'fecha,y,x\n2020-01-01,1,2\n', metadata);
    expect(await hasHandoff()).toBe(true);
    const received = await takeHandoffDataset();
    expect(received?.metadata).toEqual(metadata);
    expect(received?.metadata?.series[0].publishedAt).toBe('2026-09-10T18:52:05+00:00');
    expect(await received?.file.text()).toBe('fecha,y,x\n2020-01-01,1,2\n');
    expect(received?.file.name).toBe('conjunto.csv');
    expect(await takeHandoffDataset()).toBeNull();
  });
  it('preserves the existing cleaner handoff without metadata', async () => {
    await putHandoff('limpio.csv', new Blob(['x,y\n1,2\n']));
    expect(await (await takeHandoff())?.text()).toBe('x,y\n1,2\n');
    expect(await hasHandoff()).toBe(false);
  });
});
