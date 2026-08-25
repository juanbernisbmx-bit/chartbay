/**
 * Adapter between the C++/WASM cleaner and the shape the engine expects.
 *
 * The cleaner returns typed columns; the engine grew up on row objects. This
 * file is the seam. It deliberately does *not* rebuild rows: it hands over the
 * typed arrays as a ColumnStore and materialises only the handful of rows the
 * preview table shows. Rebuilding every row here would make the whole WASM
 * pipeline pointless — that representation is the thing it exists to avoid.
 *
 * The cleaner also already knows which columns are numeric, which are dates and
 * which are low-cardinality factors, because it voted on that while parsing. So
 * the detection heuristics on this side get to be skipped rather than re-run
 * over a sample.
 */

import {
  daySerialToIso,
  PREVIEW_ROWS,
  type ColumnStore,
  type ParsedCSV,
} from '../csvParser';
import type { CleanColumn, CleanReport } from '../../../cleaner/js/csvclean';

/**
 * The parts of a result this bridge reads. Structural on purpose: the in-page
 * path returns a CleanedTable and the worker path returns a WorkerTable, and
 * both satisfy this.
 */
export interface BridgeableTable {
  rows: number;
  columns: CleanColumn[];
  report: CleanReport;
}

export interface BridgedDataset extends ParsedCSV {
  /** Columns the cleaner typed as low-cardinality factors. */
  categoricalColumns: string[];
  /** Everything the cleaner did, and why. Shown verbatim to the user. */
  report: CleanReport;
}

function previewValue(column: CleanColumn, i: number): unknown {
  if (!column.mask[i]) return null;
  switch (column.kind) {
    case 'numeric':
      return column.values[i];
    case 'date':
      // Row objects carry the ISO string; the typed path keeps the day serial.
      return daySerialToIso(column.days[i]);
    case 'categorical':
      return column.levels[column.codes[i]] ?? null;
    case 'text':
      return column.values[i];
  }
}

export function bridgeCleanedTable(table: BridgeableTable): BridgedDataset {
  const headers = table.columns.map(column => column.name);
  const numericColumns: string[] = [];
  const categoricalColumns: string[] = [];

  const store: ColumnStore = {
    numeric: new Map(),
    categorical: new Map(),
    text: new Map(),
    dateColumns: new Set(),
    rowCount: table.rows,
  };

  for (const column of table.columns) {
    switch (column.kind) {
      case 'numeric':
        numericColumns.push(column.name);
        store.numeric.set(column.name, { values: column.values, mask: column.mask });
        break;
      case 'date':
        // Days since the epoch are a perfectly good regressor, and the engine
        // only ever asks for numbers. `dateColumns` conserva cuáles lo son,
        // para que reconstruir las filas pueda devolver el calendario a quien
        // lo necesite (series de tiempo) sin quitárselo a quien necesita el
        // número (la regresión).
        numericColumns.push(column.name);
        store.numeric.set(column.name, { values: column.days, mask: column.mask });
        store.dateColumns!.add(column.name);
        break;
      case 'categorical':
        categoricalColumns.push(column.name);
        store.categorical.set(column.name, { codes: column.codes, levels: column.levels });
        break;
      case 'text':
        store.text.set(column.name, column.values);
        break;
    }
  }

  // Only the preview rows become objects. Everything else stays columnar.
  const previewCount = Math.min(PREVIEW_ROWS, table.rows);
  const rows: Record<string, unknown>[] = new Array(previewCount);
  for (let i = 0; i < previewCount; i++) {
    const row: Record<string, unknown> = {};
    for (const column of table.columns) row[column.name] = previewValue(column, i);
    rows[i] = row;
  }

  return {
    headers,
    rows,
    numericColumns,
    categoricalColumns,
    rowCount: table.rows,
    columns: store,
    report: table.report,
  };
}
