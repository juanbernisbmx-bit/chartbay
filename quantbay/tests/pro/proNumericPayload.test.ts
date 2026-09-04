import { describe, expect, it } from 'vitest';
import type { ParsedCSV } from '../../src/csvParser';
import { buildProNumericPayload } from '../../src/pro/pyodide/proNumericPayload';

describe('buildProNumericPayload', () => {
  it('arma buffers fila-major desde datos por filas', () => {
    const data: ParsedCSV = {
      headers: ['y', 'x1', 'x2'],
      rows: [
        { y: 1, x1: 10, x2: 100 },
        { y: 2, x1: 20, x2: 200 },
      ],
      numericColumns: ['y', 'x1', 'x2'],
    };
    const result = buildProNumericPayload(data, 'y', ['x1', 'x2'], false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.yValues]).toEqual([1, 2]);
    expect([...result.value.xValues]).toEqual([10, 100, 20, 200]);
    expect(result.value).toMatchObject({ rows: 2, columns: 2, droppedRows: 0 });
  });

  it('lee el store columnar completo y no la vista previa', () => {
    const data: ParsedCSV = {
      headers: ['y', 'x'],
      rows: [{ y: 999, x: 999 }],
      numericColumns: ['y', 'x'],
      rowCount: 3,
      columns: {
        numeric: new Map([
          ['y', { values: new Float64Array([1, 2, 3]), mask: new Uint8Array([1, 1, 1]) }],
          ['x', { values: new Float64Array([4, 5, 6]), mask: new Uint8Array([1, 1, 1]) }],
        ]),
        categorical: new Map(),
        text: new Map(),
        rowCount: 3,
      },
    };
    const result = buildProNumericPayload(data, 'y', ['x'], false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.value.yValues]).toEqual([1, 2, 3]);
    expect([...result.value.xValues]).toEqual([4, 5, 6]);
  });

  it('aplica listwise antes de transferir', () => {
    const data: ParsedCSV = {
      headers: ['y', 'x'],
      rows: [{ y: 1, x: 2 }, { y: '', x: 3 }, { y: 4, x: Infinity }],
      numericColumns: ['y', 'x'],
    };
    const blocked = buildProNumericPayload(data, 'y', ['x'], false);
    expect(blocked).toMatchObject({ ok: false });

    const dropped = buildProNumericPayload(data, 'y', ['x'], true);
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    expect([...dropped.value.yValues]).toEqual([1]);
    expect([...dropped.value.xValues]).toEqual([2]);
    expect(dropped.value.droppedRows).toBe(2);
  });

  it('distingue texto inválido de una celda vacía', () => {
    const data: ParsedCSV = {
      headers: ['y', 'x'],
      rows: [{ y: 1, x: 'pesos' }, { y: 2, x: 3 }],
      numericColumns: ['y'],
    };
    const result = buildProNumericPayload(data, 'y', ['x'], true);
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(result.error).toContain('texto o formato no numérico');
    expect(result.error).toContain('"x"');
  });
});
