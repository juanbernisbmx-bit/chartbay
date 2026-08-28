import { describe, expect, it } from 'vitest';

import { bridgeCleanedTable } from '../../src/services/cleanerBridge';
import { cleanerActionNotes } from '../../src/services/cleanerLoader';
import {
  getValidRows,
  getValidRowsFrom,
  materializeRows,
  rowCountOf,
  PREVIEW_ROWS,
} from '../../src/csvParser';
import { getCompleteNumericColumnsFrom } from '../../src/services/analysisService';
import type { CleanedTable, CleanReport } from '../../../cleaner/js/csvclean';

const emptyReport: CleanReport = {
  rowsIn: 0,
  rowsOut: 0,
  columnsOut: 0,
  dialect: { delimiter: ',', quote: '"', hasHeader: true },
  quoteAnomalies: 0,
  unterminatedQuote: false,
  columns: [],
  actions: [],
};

/** Builds the shape the WASM wrapper returns, without needing the module. */
function table(rows: number, columns: CleanedTable['columns']): CleanedTable {
  const byName = new Map(columns.map(c => [c.name, c] as const));
  return {
    rows,
    columns,
    report: { ...emptyReport, rowsOut: rows, columnsOut: columns.length },
    column: name => byName.get(name),
    borrowed: false,
    toCsv: () => null,
    dispose: () => {},
  };
}

function numeric(name: string, values: number[], missing: number[] = []) {
  const mask = new Uint8Array(values.length).fill(1);
  for (const i of missing) mask[i] = 0;
  return { kind: 'numeric' as const, name, values: Float64Array.from(values), mask };
}

describe('bridgeCleanedTable', () => {
  it('surfaces every column discarded by the cleaner', () => {
    const report: CleanReport = {
      ...emptyReport,
      actions: [
        { kind: 'dropped_duplicate_column', column: 'x_copy', count: 0, detail: 'x_copy duplica x.' },
        { kind: 'inferred_dialect', column: '', count: 0, detail: 'Separador coma.' },
      ],
    };
    expect(cleanerActionNotes(report)).toEqual(['x_copy duplica x.']);
  });

  it('exposes typed columns without building a row per row', () => {
    const rows = 10_000;
    const values = Array.from({ length: rows }, (_, i) => i);
    const bridged = bridgeCleanedTable(table(rows, [numeric('x', values)]));

    expect(rowCountOf(bridged)).toBe(rows);
    expect(bridged.numericColumns).toEqual(['x']);
    // The whole point: `rows` is a preview, not the dataset.
    expect(bridged.rows.length).toBe(PREVIEW_ROWS);
    expect(bridged.columns?.numeric.get('x')?.values.length).toBe(rows);
  });

  it('keeps categoricals as codes and a dictionary, not as strings per row', () => {
    const rows = 1000;
    const codes = Int32Array.from({ length: rows }, (_, i) => i % 3);
    const bridged = bridgeCleanedTable(
      table(rows, [
        {
          kind: 'categorical',
          name: 'pais',
          codes,
          levels: ['AR', 'BR', 'CL'],
          mask: new Uint8Array(rows).fill(1),
        },
      ])
    );

    expect(bridged.categoricalColumns).toEqual(['pais']);
    expect(bridged.columns?.categorical.get('pais')?.levels).toEqual(['AR', 'BR', 'CL']);
    // No string array of length `rows` anywhere in the store.
    expect(bridged.columns?.text.size).toBe(0);
  });

  it('treats dates as numeric regressors while the report keeps the calendar', () => {
    const days = Float64Array.from([19783, 19784, 19785]);
    const bridged = bridgeCleanedTable(
      table(3, [{ kind: 'date', name: 'fecha', days, mask: new Uint8Array([1, 1, 1]) }])
    );
    expect(bridged.numericColumns).toEqual(['fecha']);
    expect(bridged.columns?.numeric.get('fecha')?.values[0]).toBe(19783);
    // The preview shows a readable date rather than a day serial.
    expect(bridged.rows[0].fecha).toBe('2024-03-01');
  });
});

describe('getValidRowsFrom', () => {
  it('matches the row-wise implementation exactly', () => {
    const y = [1, 2, 3, 4, 5, 6];
    const a = [10, 20, 30, 40, 50, 60];
    const b = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5];
    // Holes in different places in each column, which is what makes the
    // complete-case filter worth testing.
    const bridged = bridgeCleanedTable(
      table(6, [numeric('y', y, [1]), numeric('a', a, [3]), numeric('b', b, [3, 5])])
    );

    const columnar = getValidRowsFrom(bridged, 'y', ['a', 'b']);
    const rowWise = getValidRows(materializeRows(bridged), 'y', ['a', 'b']);

    expect(columnar.y).toEqual(rowWise.y);
    expect(columnar.X).toEqual(rowWise.X);
    expect(columnar.dropped).toBe(rowWise.dropped);
    // Rows 1, 3 and 5 each have a hole somewhere.
    expect(columnar.y).toEqual([1, 3, 5]);
    expect(columnar.dropped).toBe(3);
  });

  it('falls back to rows when the dataset has no columnar store', () => {
    const plain = {
      headers: ['y', 'x'],
      rows: [
        { y: 1, x: 2 },
        { y: 3, x: 4 },
      ],
      numericColumns: ['y', 'x'],
    };
    const result = getValidRowsFrom(plain, 'y', ['x']);
    expect(result.y).toEqual([1, 3]);
    expect(result.X).toEqual([[2], [4]]);
  });

  it('falls back when a requested name is not a numeric column', () => {
    // A categorical X reaches here before encoding in some paths; it must not
    // silently produce an empty design matrix.
    const bridged = bridgeCleanedTable(
      table(3, [
        numeric('y', [1, 2, 3]),
        {
          kind: 'categorical',
          name: 'g',
          codes: Int32Array.from([0, 1, 0]),
          levels: ['a', 'b'],
          mask: new Uint8Array([1, 1, 1]),
        },
      ])
    );
    const result = getValidRowsFrom(bridged, 'y', ['g']);
    // The row-wise path rejects non-numeric cells, so nothing survives — the
    // same answer it gave before, rather than a wrong one.
    expect(result.y.length).toBe(0);
    expect(result.dropped).toBe(3);
  });
});

describe('getCompleteNumericColumnsFrom', () => {
  it('agrees with the row-wise version on complete-case selection', () => {
    const bridged = bridgeCleanedTable(
      table(5, [numeric('a', [1, 2, 3, 4, 5], [2]), numeric('b', [9, 8, 7, 6, 5], [4])])
    );
    expect(getCompleteNumericColumnsFrom(bridged)).toEqual([
      [1, 2, 4],
      [9, 8, 6],
    ]);
  });
});

describe('materializeRows', () => {
  it('rebuilds every row, including missing cells and factor levels', () => {
    const bridged = bridgeCleanedTable(
      table(3, [
        numeric('x', [1, 2, 3], [1]),
        {
          kind: 'categorical',
          name: 'g',
          codes: Int32Array.from([0, -1, 1]),
          levels: ['alfa', 'beta'],
          mask: new Uint8Array([1, 0, 1]),
        },
      ])
    );
    const rows = materializeRows(bridged);
    expect(rows.length).toBe(3);
    expect(rows[0]).toEqual({ x: 1, g: 'alfa' });
    expect(rows[1]).toEqual({ x: null, g: null });
    expect(rows[2]).toEqual({ x: 3, g: 'beta' });
  });

  it('returns the rows unchanged when there is nothing to materialise', () => {
    const plain = { headers: ['a'], rows: [{ a: 1 }], numericColumns: ['a'] };
    expect(materializeRows(plain)).toBe(plain.rows);
  });
});
