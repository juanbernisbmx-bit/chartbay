/* eslint-disable @typescript-eslint/no-explicit-any */
declare const Papa: any; // bundled and exposed by main.ts

/**
 * Columnar backing for a dataset, as produced by the C++/WASM cleaner.
 *
 * Present only on the columnar path. When it is there, the hot functions in
 * this file read it directly and never touch `rows`, which is what keeps a
 * multi-million-row file from becoming multi-million JavaScript objects.
 */
export interface ColumnStore {
  /** Column name → values. `mask[i] === 0` marks a missing cell. */
  numeric: Map<string, { values: Float64Array; mask: Uint8Array }>;
  /**
   * Low-cardinality columns, kept as dictionary codes rather than strings.
   * One Int32 per row plus the level list, instead of one string per row —
   * which is the difference between 4 bytes and ~40 for a country name.
   */
  categorical: Map<string, { codes: Int32Array; levels: string[] }>;
  /** Free text. The one column kind that genuinely costs a string per row. */
  text: Map<string, string[]>;
  /**
   * Cuáles de las columnas de `numeric` son fechas.
   *
   * El limpiador las guarda como días desde la época porque así son regresoras
   * usables sin convertir nada, pero esa decisión borraba el significado de
   * calendario: sin esta lista, reconstruir las filas devolvía 19723 donde la
   * vista previa mostraba "2024-01-01", y series de tiempo rechazaba el
   * dataset entero por fechas inválidas.
   *
   * Opcional porque hay fixtures que arman un ColumnStore a mano; ausente
   * significa "ninguna columna es fecha".
   */
  dateColumns?: Set<string>;
  rowCount: number;
}

export interface ParsedCSV {
  headers: string[];
  /**
   * Row objects.
   *
   * On the PapaParse path this is the whole dataset. On the columnar path it
   * holds only a bounded preview — `PREVIEW_ROWS` of them — because
   * materialising every row is the cost the columnar path exists to avoid.
   * Anything that needs a full row-wise pass must call `materializeRows`,
   * which says so in its name and is O(rows) on purpose.
   */
  rows: Record<string, unknown>[];
  numericColumns: string[];
  /**
   * Authoritative row count. Optional so the many existing row-wise call sites
   * keep constructing a ParsedCSV the way they always did; use `rowCountOf`
   * rather than reading it, and never use `rows.length` when `columns` may be
   * present, because there `rows` is only the preview.
   */
  rowCount?: number;
  columns?: ColumnStore;
}

/** Rows kept for the preview table on the columnar path. */
export const PREVIEW_ROWS = 50;

/** Días desde 1970-01-01 a la fecha ISO que ve el usuario. */
export function daySerialToIso(serial: number): string {
  return new Date(serial * 86_400_000).toISOString().slice(0, 10);
}

/** The row count, whichever representation the dataset happens to use. */
export function rowCountOf(data: ParsedCSV): number {
  return data.rowCount ?? data.rows.length;
}

export function parseCSVFile(file: File): Promise<ParsedCSV> {
  if (typeof Papa === 'undefined') {
    return Promise.reject(new Error('PapaParse no cargado'));
  }
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      complete(result: { meta: { fields?: string[] }; data: Record<string, unknown>[] }) {
        const headers = result.meta.fields ?? [];
        const rows = result.data;
        const numericColumns = headers.filter(
          h =>
            rows.length > 0 &&
            rows.every(row => {
              const v = row[h];
              return v !== null && v !== '' && !isNaN(Number(v));
            })
        );
        resolve({ headers, rows, numericColumns });
      },
      error(err: unknown) {
        reject(new Error(String(err)));
      },
    });
  });
}

function isValidNumeric(raw: unknown): boolean {
  if (raw === null || raw === undefined || raw === '') return false;
  const v = Number(raw);
  return !isNaN(v) && isFinite(v);
}

export function extractColumn(
  rows: Record<string, unknown>[],
  column: string
): number[] {
  return rows.reduce<number[]>((acc, row) => {
    const raw = row[column];
    if (isValidNumeric(raw)) acc.push(Number(raw));
    return acc;
  }, []);
}

/**
 * Builds row objects from the columnar store.
 *
 * Named for what it costs. This is the one bridge back to the row-wise world,
 * for code that has not been converted — the time-series engine, mainly — and
 * it allocates one object per row, which is exactly the representation the
 * columnar path avoids. Call it deliberately, never in a loop.
 */
/**
 * Cómo devolver las columnas de fecha al reconstruir filas.
 *
 * Las dos lecturas son válidas y cada consumidor necesita una: la regresión
 * quiere el número (una fecha es una tendencia perfectamente usable como X) y
 * series de tiempo quiere el calendario. Es un parámetro y no un default
 * global justamente porque elegir mal rompe al otro en silencio: con ISO, la
 * codificación de dummies toma la fecha por categórica y arma una dummy por
 * día; con serial, el validador de series rechaza todas las filas.
 */
export type DateCellFormat = 'serial' | 'iso';

export function materializeRows(
  data: ParsedCSV,
  options: { dates?: DateCellFormat } = {}
): Record<string, unknown>[] {
  if (!data.columns) return data.rows;
  const { numeric, text, rowCount, dateColumns } = data.columns;
  const isoDates = options.dates === 'iso' && dateColumns !== undefined && dateColumns.size > 0;

  const out: Record<string, unknown>[] = new Array(rowCount);
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, unknown> = {};
    for (const header of data.headers) {
      const column = numeric.get(header);
      if (column) {
        if (!column.mask[i]) {
          row[header] = null;
        } else {
          row[header] = isoDates && dateColumns!.has(header)
            ? daySerialToIso(column.values[i])
            : column.values[i];
        }
        continue;
      }
      const factor = data.columns.categorical.get(header);
      if (factor) {
        const code = factor.codes[i];
        row[header] = code >= 0 ? factor.levels[code] : null;
        continue;
      }
      const strings = text.get(header);
      row[header] = strings ? (strings[i] ?? null) : null;
    }
    out[i] = row;
  }
  return out;
}

/**
 * Recorre TODAS las celdas de una columna, en el dataset entero.
 *
 * Es la versión barata de `materializeRows` cuando sólo hace falta mirar una
 * columna: lee los arrays tipados sin construir un objeto por fila. Existe
 * porque contar faltantes sobre `data.rows` en el camino columnar cuenta sobre
 * la vista previa —50 filas— y no sobre el archivo.
 *
 * Entrega el mismo valor que vería la vía por filas: el número, la etiqueta de
 * la categórica, el texto, o `null` cuando la celda está vacía. Las columnas de
 * fecha viven en el store numérico como días desde la época, así que salen como
 * números: son regresoras válidas, igual que las trata `getValidRowsFrom`.
 */
export function forEachCellOf(
  data: ParsedCSV,
  column: string,
  visit: (value: unknown) => void
): void {
  const store = data.columns;
  if (!store) {
    for (const row of data.rows) visit(row[column]);
    return;
  }

  const numeric = store.numeric.get(column);
  if (numeric) {
    for (let i = 0; i < store.rowCount; i++) visit(numeric.mask[i] ? numeric.values[i] : null);
    return;
  }

  const factor = store.categorical.get(column);
  if (factor) {
    for (let i = 0; i < store.rowCount; i++) {
      const code = factor.codes[i];
      visit(code >= 0 ? factor.levels[code] : null);
    }
    return;
  }

  const strings = store.text.get(column);
  if (strings) {
    for (let i = 0; i < store.rowCount; i++) visit(strings[i] ?? null);
    return;
  }

  // Nombre que no está en el store (una dummy recién creada, por ejemplo):
  // mismo comportamiento que la vía por filas.
  for (const row of data.rows) visit(row[column]);
}

export function extractMatrix(
  rows: Record<string, unknown>[],
  columns: string[]
): { X: number[][]; validIndices: number[] } {
  const X: number[][] = [];
  const validIndices: number[] = [];
  rows.forEach((row, i) => {
    if (columns.every(col => isValidNumeric(row[col]))) {
      X.push(columns.map(col => Number(row[col])));
      validIndices.push(i);
    }
  });
  return { X, validIndices };
}

export function getValidRows(
  rows: Record<string, unknown>[],
  yName: string,
  xNames: string[]
): { X: number[][]; y: number[]; dropped: number } {
  const allCols = [yName, ...xNames];
  const valid = rows.filter(row => allCols.every(col => isValidNumeric(row[col])));
  return {
    X: valid.map(row => xNames.map(col => Number(row[col]))),
    y: valid.map(row => Number(row[yName])),
    dropped: rows.length - valid.length,
  };
}

/**
 * Same contract as getValidRows, reading typed arrays instead of row objects.
 *
 * This is the function the whole columnar path exists for: it walks
 * Float64Arrays and allocates only the result, so a million-row regression
 * never builds a million objects. Falls back to the row-wise version when
 * there is no columnar store, so callers do not have to branch.
 */
export function getValidRowsFrom(
  data: ParsedCSV,
  yName: string,
  xNames: string[]
): { X: number[][]; y: number[]; dropped: number } {
  if (!data.columns) return getValidRows(data.rows, yName, xNames);

  const { numeric, rowCount } = data.columns;
  const yCol = numeric.get(yName);
  const xCols = xNames.map(name => numeric.get(name));
  // A name that is not a numeric column cannot take part in a regression; let
  // the row-wise path produce the same error it always did.
  if (!yCol || xCols.some(col => !col)) {
    return getValidRows(materializeRows(data), yName, xNames);
  }

  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < rowCount; i++) {
    if (!yCol.mask[i]) continue;
    let complete = true;
    for (const col of xCols) {
      if (!col!.mask[i]) {
        complete = false;
        break;
      }
    }
    if (!complete) continue;
    const rowValues = new Array<number>(xCols.length);
    for (let j = 0; j < xCols.length; j++) rowValues[j] = xCols[j]!.values[i];
    X.push(rowValues);
    y.push(yCol.values[i]);
  }
  return { X, y, dropped: rowCount - y.length };
}
