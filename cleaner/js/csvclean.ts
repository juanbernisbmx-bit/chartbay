/**
 * TypeScript front end for the WASM cleaner.
 *
 * This is the piece that plugs into ChartBay. It streams a File through the
 * C++ core in chunks and returns columnar data — typed arrays, not row objects.
 *
 * That distinction is the whole point. The current path
 * (quantbay/src/csvParser.ts) builds one JavaScript object per row with string
 * keys, so a 200 MB CSV becomes several gigabytes of heap and dies. Here a
 * numeric column of n rows is exactly 8n bytes.
 *
 * Build the module first:  cd cleaner && make wasm
 */

// ── Module surface ────────────────────────────────────────────────────────────

interface WasmModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  UTF8ToString(ptr: number): string;
  _cbc_alloc(n: number): number;
  _cbc_free(ptr: number): void;
  _cbc_create(ints: number, nints: number, reals: number, nreals: number): number;
  _cbc_destroy(handle: number): void;
  _cbc_feed(handle: number, data: number, n: number): number;
  _cbc_finish(handle: number): number;
  _cbc_error(handle: number): number;
  _cbc_row_count(handle: number): number;
  _cbc_column_count(handle: number): number;
  _cbc_column_name(handle: number, j: number): number;
  _cbc_column_type(handle: number, j: number): number;
  _cbc_column_values(handle: number, j: number): number;
  _cbc_column_mask(handle: number, j: number): number;
  _cbc_column_codes(handle: number, j: number): number;
  _cbc_level_count(handle: number, j: number): number;
  _cbc_level_name(handle: number, j: number, k: number): number;
  _cbc_text_blob(handle: number, j: number): number;
  _cbc_text_offsets(handle: number, j: number): number;
  _cbc_release_column(handle: number, j: number): void;
  _cbc_report_json(handle: number): number;
}

declare function CsvCleanModule(config?: Record<string, unknown>): Promise<WasmModule>;

// ── Public types ──────────────────────────────────────────────────────────────

export type MissingPolicy = 'keep' | 'drop' | 'zero' | 'mean' | 'median' | 'ffill';
export type OutlierPolicy = 'flag' | 'winsorize' | 'missing' | 'drop';
export type OutlierRule = 'iqr' | 'zscore' | 'mad';

export interface CleanOptions {
  delimiter?: string;          // omit to sniff
  hasHeader?: boolean;
  fallbackDecimal?: '.' | ',';
  fallbackDateOrder?: 'ymd' | 'dmy' | 'mdy';
  sampleRows?: number;
  maxCategoricalLevels?: number;
  percentAsFraction?: boolean; // "12,5%" → 0.125 instead of 12.5
  dropEmptyRows?: boolean;
  dropDuplicateRows?: boolean;
  dropEmptyColumns?: boolean;
  dropConstantColumns?: boolean;
  dropDuplicateColumns?: boolean;
  missing?: MissingPolicy;
  outliers?: OutlierPolicy;
  outlierRule?: OutlierRule;
  numericThreshold?: number;
  dateThreshold?: number;
  categoricalRatio?: number;
  outlierK?: number;
  /** Bytes handed to the core per call. Larger is marginally faster. */
  chunkBytes?: number;
  /** Called with a 0..1 fraction as the file is read. */
  onProgress?: (fraction: number) => void;
  /**
   * Whether the returned typed arrays are copies owned by JavaScript.
   *
   * WASM memory only ever grows — freeing inside the module does not give
   * anything back to the browser. So a copy is not "instead of" the WASM
   * buffers, it is *on top of* them, and it roughly doubles peak usage.
   *
   * - `true`  — safest. The handle is released before this resolves.
   * - `false` — the arrays are views into WASM memory. Peak stays at what the
   *             core used, but you must call `dispose()` before cleaning
   *             another file, and the views die with it.
   * - omitted — copies below `borrowAboveBytes` of column data, views above.
   */
  copy?: boolean;
  /** Threshold for the automatic choice above. Default 64 MB. */
  borrowAboveBytes?: number;
}

/** mask[i] === 1 when row i has a value; 0 when it is missing. */
export interface BaseColumn {
  name: string;
  mask: Uint8Array;
}

export interface NumericColumn extends BaseColumn {
  kind: 'numeric';
  values: Float64Array;
}

export interface DateColumn extends BaseColumn {
  kind: 'date';
  /** Days since 1970-01-01. Multiply by 86 400 000 for a JS Date. */
  days: Float64Array;
}

export interface CategoricalColumn extends BaseColumn {
  kind: 'categorical';
  codes: Int32Array;
  levels: string[];
}

export interface TextColumn extends BaseColumn {
  kind: 'text';
  values: string[];
}

export type CleanColumn = NumericColumn | DateColumn | CategoricalColumn | TextColumn;

export interface ColumnReport {
  name: string;
  originalName: string;
  type: 'numeric' | 'date' | 'categorical' | 'text' | 'empty';
  present: number;
  missing: number;
  invalid: number;
  unique: number;
  outliers: number;
  min?: number;
  max?: number;
  mean?: number;
  sd?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  decimalSeparator?: string;
  sawPercent?: boolean;
  sawCurrency?: boolean;
  ambiguousDecimal?: boolean;
  dateOrder?: string;
  dateGrain?: string;
  ambiguousDateOrder?: boolean;
  minDate?: string;
  maxDate?: string;
  levels?: string[];
}

export interface CleanAction {
  kind: string;
  column: string;
  count: number;
  /** Plain-language Spanish, with the reason. Show this to the user verbatim. */
  detail: string;
}

export interface CleanReport {
  rowsIn: number;
  rowsOut: number;
  columnsOut: number;
  dialect: { delimiter: string; quote: string; hasHeader: boolean };
  quoteAnomalies: number;
  unterminatedQuote: boolean;
  columns: ColumnReport[];
  actions: CleanAction[];
}

export interface CleanedTable {
  rows: number;
  columns: CleanColumn[];
  report: CleanReport;
  column(name: string): CleanColumn | undefined;
  /** True when the typed arrays are views into WASM memory, not copies. */
  readonly borrowed: boolean;
  /**
   * Releases the WASM handle. Mandatory for a borrowed table before cleaning
   * another file — the arrays are unusable afterwards. A no-op when copied.
   */
  dispose(): void;
}

// ── Option encoding ───────────────────────────────────────────────────────────

// Mirrors the Ints/Reals enums in wasm/bindings.cpp. Keep the two in step.
const INT_SLOTS = 16;
const REAL_SLOTS = 5;

const MISSING_CODES: Record<MissingPolicy, number> = {
  keep: 0, drop: 1, zero: 2, mean: 3, median: 4, ffill: 5,
};
const OUTLIER_CODES: Record<OutlierPolicy, number> = {
  flag: 0, winsorize: 1, missing: 2, drop: 3,
};
const RULE_CODES: Record<OutlierRule, number> = { iqr: 0, zscore: 1, mad: 2 };
const ORDER_CODES: Record<string, number> = { unknown: 0, ymd: 1, dmy: 2, mdy: 3 };

function encodeOptions(
  options: CleanOptions,
  totalBytes: number
): { ints: Int32Array; reals: Float64Array } {
  const ints = new Int32Array(INT_SLOTS);
  const reals = new Float64Array(REAL_SLOTS);
  const flag = (value: boolean | undefined, fallback: number) =>
    value === undefined ? fallback : value ? 1 : 0;

  ints[0] = options.delimiter ? 0 : 1;                       // sniff
  ints[1] = options.delimiter ? options.delimiter.charCodeAt(0) : 0;
  ints[2] = flag(options.hasHeader, 1);
  ints[3] = (options.fallbackDecimal ?? '.').charCodeAt(0);
  ints[4] = ORDER_CODES[options.fallbackDateOrder ?? 'dmy'] ?? 2;
  ints[5] = options.sampleRows ?? 0;
  ints[6] = options.maxCategoricalLevels ?? 0;
  ints[7] = flag(options.percentAsFraction, 0);
  ints[8] = flag(options.dropEmptyRows, 1);
  ints[9] = flag(options.dropDuplicateRows, 1);
  ints[10] = flag(options.dropEmptyColumns, 1);
  ints[11] = flag(options.dropConstantColumns, 1);
  ints[12] = flag(options.dropDuplicateColumns, 1);
  ints[13] = MISSING_CODES[options.missing ?? 'keep'];
  ints[14] = OUTLIER_CODES[options.outliers ?? 'flag'];
  ints[15] = RULE_CODES[options.outlierRule ?? 'iqr'];

  reals[0] = options.numericThreshold ?? 0.8;
  reals[1] = options.dateThreshold ?? 0.9;
  reals[2] = options.categoricalRatio ?? 0.2;
  reals[3] = options.outlierK ?? 3;
  reals[4] = totalBytes;
  return { ints, reals };
}

// ── Module loading ────────────────────────────────────────────────────────────

let modulePromise: Promise<WasmModule> | null = null;

/** Loads (once) the WASM module emitted by `make wasm`. */
export function loadCleaner(config?: Record<string, unknown>): Promise<WasmModule> {
  if (!modulePromise) modulePromise = CsvCleanModule(config);
  return modulePromise;
}

// ── Main entry point ──────────────────────────────────────────────────────────

const ERRORS: Record<number, string> = {
  1: 'El limpiador se usó en un orden inválido.',
  2: 'El archivo no entra en memoria. Probá con un recorte más chico.',
  3: 'Error interno del limpiador.',
};

// A borrowed table pins WASM memory: cleaning another file would grow the heap
// and detach every view handed out. Tracked so the failure is a clear message
// rather than silently corrupted arrays.
let liveBorrowed: CleanedTable | null = null;

/**
 * Streams `file` through the cleaner and returns typed columns.
 *
 * See `CleanOptions.copy` for who owns the returned arrays. The default copies
 * small results and borrows large ones, which is what makes a half-gigabyte
 * file fit in a browser tab.
 */
export async function cleanCsv(file: Blob, options: CleanOptions = {}): Promise<CleanedTable> {
  if (liveBorrowed) {
    throw new Error(
      'Hay una tabla anterior tomada por referencia sobre la memoria WASM. ' +
        'Llamá a dispose() sobre ella antes de limpiar otro archivo.'
    );
  }
  const wasm = await loadCleaner();
  const { ints, reals } = encodeOptions(options, file.size);

  const intPtr = wasm._cbc_alloc(ints.byteLength);
  const realPtr = wasm._cbc_alloc(reals.byteLength);
  wasm.HEAP32.set(ints, intPtr >> 2);
  wasm.HEAPF64.set(reals, realPtr >> 3);
  const handle = wasm._cbc_create(intPtr, ints.length, realPtr, reals.length);
  wasm._cbc_free(intPtr);
  wasm._cbc_free(realPtr);
  if (!handle) throw new Error(ERRORS[2]);

  const chunkBytes = options.chunkBytes ?? 4 * 1024 * 1024;
  let buffer = wasm._cbc_alloc(chunkBytes);

  try {
    for (let offset = 0; offset < file.size; offset += chunkBytes) {
      const slice = file.slice(offset, Math.min(offset + chunkBytes, file.size));
      const bytes = new Uint8Array(await slice.arrayBuffer());
      // HEAPU8 is re-read every iteration: growing WASM memory detaches the
      // previous ArrayBuffer and any view over it.
      wasm.HEAPU8.set(bytes, buffer);
      const code = wasm._cbc_feed(handle, buffer, bytes.length);
      if (code !== 0) throw new Error(ERRORS[code] ?? ERRORS[3]);
      options.onProgress?.(Math.min(1, (offset + bytes.length) / Math.max(1, file.size)));
    }
    wasm._cbc_free(buffer);
    buffer = 0;

    const code = wasm._cbc_finish(handle);
    if (code !== 0) throw new Error(ERRORS[code] ?? ERRORS[3]);

    const table = readTable(wasm, handle, decideBorrow(wasm, handle, options));
    if (table.borrowed) liveBorrowed = table;
    else wasm._cbc_destroy(handle);
    return table;
  } catch (err) {
    wasm._cbc_destroy(handle);
    throw err;
  } finally {
    if (buffer) wasm._cbc_free(buffer);
  }
}

/** Copies below the threshold, borrows above it. */
function decideBorrow(wasm: WasmModule, handle: number, options: CleanOptions): boolean {
  if (options.copy !== undefined) return !options.copy;
  const rows = wasm._cbc_row_count(handle);
  const count = wasm._cbc_column_count(handle);
  let bytes = 0;
  for (let j = 0; j < count; j++) {
    const type = wasm._cbc_column_type(handle, j);
    // Text becomes JS strings either way, so it does not affect the choice.
    bytes += rows * (type === 1 || type === 2 ? 9 : type === 3 ? 5 : 1);
  }
  return bytes > (options.borrowAboveBytes ?? 64 * 1024 * 1024);
}

function readTable(wasm: WasmModule, handle: number, borrow: boolean): CleanedTable {
  const rows = wasm._cbc_row_count(handle);
  const count = wasm._cbc_column_count(handle);
  const columns: CleanColumn[] = [];

  // Everything that allocates inside WASM has to happen before the first view
  // is taken: growing the heap detaches every ArrayBuffer handed out so far.
  // The report string and the text blobs are the only allocators left here.
  const reportJson = wasm.UTF8ToString(wasm._cbc_report_json(handle));
  for (let j = 0; j < count; j++) {
    if (wasm._cbc_column_type(handle, j) === 4) wasm._cbc_text_blob(handle, j);
  }

  for (let j = 0; j < count; j++) {
    const name = wasm.UTF8ToString(wasm._cbc_column_name(handle, j));
    const type = wasm._cbc_column_type(handle, j);
    const maskPtr = wasm._cbc_column_mask(handle, j);
    const mask = maskPtr
      ? take(wasm.HEAPU8, maskPtr, rows, borrow)
      : new Uint8Array(rows);

    if (type === 1 || type === 2) {
      const ptr = wasm._cbc_column_values(handle, j);
      const values = ptr
        ? take(wasm.HEAPF64, ptr >> 3, rows, borrow)
        : new Float64Array(rows);
      columns.push(
        type === 1
          ? { kind: 'numeric', name, mask, values }
          : { kind: 'date', name, mask, days: values }
      );
    } else if (type === 3) {
      const ptr = wasm._cbc_column_codes(handle, j);
      const codes = ptr
        ? take(wasm.HEAP32, ptr >> 2, rows, borrow)
        : new Int32Array(rows);
      const levelCount = wasm._cbc_level_count(handle, j);
      const levels: string[] = [];
      for (let k = 0; k < levelCount; k++) {
        levels.push(wasm.UTF8ToString(wasm._cbc_level_name(handle, j, k)));
      }
      columns.push({ kind: 'categorical', name, mask, codes, levels });
    } else {
      // Text: one UTF-8 blob plus rows+1 offsets, decoded in a single pass.
      const blobPtr = wasm._cbc_text_blob(handle, j);
      const offsetsPtr = wasm._cbc_text_offsets(handle, j);
      const values: string[] = new Array(rows);
      if (blobPtr && offsetsPtr) {
        const offsets = wasm.HEAPU32.subarray(offsetsPtr >> 2, (offsetsPtr >> 2) + rows + 1);
        const decoder = new TextDecoder();
        const blob = wasm.HEAPU8;
        for (let i = 0; i < rows; i++) {
          values[i] = mask[i]
            ? decoder.decode(blob.subarray(blobPtr + offsets[i], blobPtr + offsets[i + 1]))
            : '';
        }
      } else {
        values.fill('');
      }
      columns.push({ kind: 'text', name, mask, values });
    }

    // Once copied out, the module can reuse the space. It does not shrink the
    // WASM heap — nothing does — but it keeps the next file from growing it.
    if (!borrow) wasm._cbc_release_column(handle, j);
  }

  const report = JSON.parse(reportJson) as CleanReport;
  const byName = new Map<string, CleanColumn>(
    columns.map(column => [column.name, column] as [string, CleanColumn])
  );

  let disposed = false;
  const table: CleanedTable = {
    rows,
    columns,
    report,
    borrowed: borrow,
    column: name => byName.get(name),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (!borrow) return;
      if (liveBorrowed === table) liveBorrowed = null;
      // The views are dead from here on; blank them so a stale reader gets an
      // empty array rather than whatever the allocator reuses the bytes for.
      for (const column of columns) {
        (column as { mask: Uint8Array }).mask = new Uint8Array(0);
        if (column.kind === 'numeric') column.values = new Float64Array(0);
        else if (column.kind === 'date') column.days = new Float64Array(0);
        else if (column.kind === 'categorical') column.codes = new Int32Array(0);
      }
      (table as { rows: number }).rows = 0;
      wasm._cbc_destroy(handle);
    },
  };
  return table;
}

/**
 * A view into WASM memory, or a copy of it.
 *
 * `subarray` shares the underlying buffer; `slice` allocates a JS-owned copy.
 * The copy is not a replacement for the WASM buffer — WASM memory never
 * shrinks — so on a large file it is pure addition to the peak.
 */
function take<T extends Uint8Array | Int32Array | Float64Array>(
  heap: T,
  start: number,
  length: number,
  borrow: boolean
): T {
  return (borrow
    ? heap.subarray(start, start + length)
    : heap.slice(start, start + length)) as T;
}

// ── Adapters for the existing engine ──────────────────────────────────────────

/**
 * Builds the X matrix and y vector for a regression straight from the columns,
 * keeping only rows where every selected variable is present.
 *
 * This is the replacement for getValidRows() in quantbay/src/csvParser.ts. That
 * one walks an array of row objects and does a string-keyed lookup per cell;
 * this walks contiguous Float64Arrays.
 */
export function extractMatrix(
  table: CleanedTable,
  yName: string,
  xNames: string[]
): { X: number[][]; y: number[]; dropped: number } {
  const pick = (name: string): Float64Array => {
    const column = table.column(name);
    if (!column) throw new Error(`La columna "${name}" no existe en el dataset limpio.`);
    if (column.kind === 'numeric') return column.values;
    if (column.kind === 'date') return column.days;
    throw new Error(`La columna "${name}" no es numérica (es ${column.kind}).`);
  };
  const maskOf = (name: string): Uint8Array => table.column(name)!.mask;

  const yValues = pick(yName);
  const yMask = maskOf(yName);
  const xValues = xNames.map(pick);
  const xMasks = xNames.map(maskOf);

  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < table.rows; i++) {
    if (!yMask[i]) continue;
    let complete = true;
    for (let k = 0; k < xMasks.length && complete; k++) complete = xMasks[k][i] === 1;
    if (!complete) continue;
    X.push(xValues.map(column => column[i]));
    y.push(yValues[i]);
  }
  return { X, y, dropped: table.rows - y.length };
}

/**
 * Names of the columns a regression can actually use.
 * Categoricals are excluded here; they still need dummy encoding upstream.
 */
export function numericColumnNames(table: CleanedTable): string[] {
  return table.columns
    .filter(column => column.kind === 'numeric' || column.kind === 'date')
    .map(column => column.name);
}

/**
 * Row-object view, for code that has not been ported to columns yet.
 *
 * Use it only for the preview table — it rebuilds exactly the representation
 * this module exists to avoid, so never call it with the whole dataset. It
 * takes a row limit for that reason.
 */
export function toRowObjects(table: CleanedTable, limit = 100): Record<string, unknown>[] {
  const n = Math.min(limit, table.rows);
  const out: Record<string, unknown>[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const row: Record<string, unknown> = {};
    for (const column of table.columns) {
      if (!column.mask[i]) {
        row[column.name] = null;
        continue;
      }
      switch (column.kind) {
        case 'numeric': row[column.name] = column.values[i]; break;
        case 'date': row[column.name] = isoFromDays(column.days[i]); break;
        case 'categorical': row[column.name] = column.levels[column.codes[i]]; break;
        case 'text': row[column.name] = column.values[i]; break;
      }
    }
    out[i] = row;
  }
  return out;
}

/** Days since 1970-01-01 → "YYYY-MM-DD". */
export function isoFromDays(days: number): string {
  return new Date(days * 86400000).toISOString().slice(0, 10);
}
