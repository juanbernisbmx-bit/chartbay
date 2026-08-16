/**
 * Pre-flight: look at a small head of the file, and say what each processing
 * mode would cost before committing to any of it.
 *
 * The central claim this module encodes is that **file size does not determine
 * memory — the algorithm does**. A pure streaming scan holds a fixed number of
 * bytes per column and nothing per row, so it can read a file far larger than
 * the machine's memory. Materialising columns costs bytes per row. Global
 * duplicate detection costs bytes per row on top of that. Those are three very
 * different limits and collapsing them into one "max file size" would be wrong
 * in both directions at once.
 *
 * Measured on the reference 516 MB / 7.9 M-row file (see processingLimits.ts):
 *
 *   basic scan          16 MB heap    7.6 s
 *   scan + duplicates  137 MB heap   10.9 s
 *   standard clean     727 MB heap   17.2 s
 */

import type { MemoryBudget } from './deviceProfiler';
import {
  BYTES_PER_CATEGORICAL_ROW,
  BYTES_PER_DATE_ROW,
  BYTES_PER_NUMERIC_ROW,
  BYTES_PER_SORTED_VALUE,
  DUPLICATE_BYTES_PER_SLOT,
  DUPLICATE_LOAD_FACTOR,
  HARD_BLOCK_MULTIPLIER,
  PREFLIGHT_SAMPLE_BYTES,
  TEXT_STRING_OVERHEAD_BYTES,
  WARNING_THRESHOLDS,
  WASM_ALLOCATOR_OVERHEAD,
  WASM_PLANNING_LIMIT_BYTES,
  WASM_THROUGHPUT_BYTES_PER_SECOND,
} from './processingLimits';

export type ProcessingMode =
  | 'basic-scan'
  | 'standard-clean'
  | 'global-duplicates'
  | 'full-analysis';

export type ProcessingStatus = 'safe' | 'warning' | 'not-recommended' | 'blocked';

export interface ProcessingRecommendation {
  mode: ProcessingMode;
  status: ProcessingStatus;
  /** Absent when the mode's memory does not scale with file size. */
  recommendedMaxFileBytes?: number;
  warningThresholdBytes?: number;
  /** Only set when a real technical ceiling exists, not as policy. */
  hardLimitBytes?: number;
  estimatedMemoryBytes: number;
  estimatedSeconds: number;
  reason: string;
}

export interface ColumnShapeGuess {
  numeric: number;
  date: number;
  categorical: number;
  text: number;
  averageTextLength: number;
}

export interface FileEstimate {
  fileBytes: number;
  sampledBytes: number;
  sampledRows: number;
  averageRowBytes: number;
  estimatedRows: number;
  columnCount: number;
  shape: ColumnShapeGuess;
  /** True when the sample was the entire file, so the row count is exact. */
  exact: boolean;
}

export interface PreflightResult {
  file: FileEstimate;
  budget: MemoryBudget;
  recommendations: Record<ProcessingMode, ProcessingRecommendation>;
  /** The most capable mode that is still `safe`, or basic-scan as a floor. */
  recommendedMode: ProcessingMode;
}

// ── Sampling ──────────────────────────────────────────────────────────────────

const NUMERIC_LIKE = /^[\s$€£¥(]*[+-]?[\d.,'  ]+[)%\s]*$/;
// Tight on purpose: a looser pattern reads "5.50" as a date, because a dot is
// a legal date separator. Either a four-digit year leads, or there are three
// components with a plausible year at the end.
const DATE_LIKE =
  /^\s*(\d{4}[-/][01]?\d([-/][0-3]?\d)?|[0-3]?\d[-/.][01]?\d[-/.]\d{2,4})\s*$/;

function splitLine(line: string, delimiter: string): string[] {
  // Deliberately naive: quoted delimiters would need the real parser, and this
  // only has to be good enough to guess a column count and a rough type mix.
  return line.split(delimiter);
}

function guessDelimiter(head: string): string {
  const firstLine = head.split('\n', 1)[0] ?? '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = firstLine.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

/**
 * Reads the head of the file and derives an average row size.
 *
 * Known imprecision, stated rather than hidden: newlines inside quoted fields
 * are counted as row breaks, which inflates the row estimate and therefore the
 * memory estimate. Erring high is the safe direction for a budget.
 */
export async function estimateFile(
  file: Blob,
  sampleBytes: number = PREFLIGHT_SAMPLE_BYTES
): Promise<FileEstimate> {
  const readBytes = Math.min(sampleBytes, file.size);
  const head = await file.slice(0, readBytes).text();
  const exact = readBytes >= file.size;

  // Only whole lines count, so a truncated tail cannot skew the average.
  const lastBreak = head.lastIndexOf('\n');
  const usable = exact ? head : lastBreak >= 0 ? head.slice(0, lastBreak + 1) : '';
  const lines = usable.split('\n').filter(line => line.length > 0);

  const delimiter = guessDelimiter(usable);
  const header = lines.length > 0 ? splitLine(lines[0], delimiter) : [];
  const columnCount = Math.max(header.length, 1);

  // Assume a header row; if there is none the row count is off by one, which is
  // irrelevant at these magnitudes.
  const dataLines = lines.slice(1);
  const sampledRows = dataLines.length;
  const sampledBytes = usable.length - (lines[0]?.length ?? 0) - 1;

  const averageRowBytes =
    sampledRows > 0 && sampledBytes > 0 ? sampledBytes / sampledRows : Math.max(1, usable.length);
  const estimatedRows = exact
    ? sampledRows
    : Math.max(1, Math.round((file.size - (lines[0]?.length ?? 0)) / averageRowBytes));

  return {
    fileBytes: file.size,
    sampledBytes: Math.max(0, sampledBytes),
    sampledRows,
    averageRowBytes,
    estimatedRows,
    columnCount,
    shape: guessShape(dataLines, delimiter, columnCount),
    exact,
  };
}

/**
 * Cheap column typing over the sampled rows. Not the real inference — that
 * lives in C++ and votes on separators — but close enough that the memory
 * estimate is not simply "assume the worst for every column".
 */
function guessShape(
  dataLines: string[],
  delimiter: string,
  columnCount: number
): ColumnShapeGuess {
  const shape: ColumnShapeGuess = {
    numeric: 0,
    date: 0,
    categorical: 0,
    text: 0,
    averageTextLength: 0,
  };
  if (dataLines.length === 0) {
    shape.numeric = columnCount;
    return shape;
  }

  const rows = dataLines.slice(0, 500).map(line => splitLine(line, delimiter));
  let textLengthTotal = 0;
  let textCells = 0;

  for (let j = 0; j < columnCount; j++) {
    let numeric = 0;
    let date = 0;
    let filled = 0;
    const distinct = new Set<string>();

    for (const row of rows) {
      const cell = (row[j] ?? '').trim();
      if (cell === '') continue;
      filled++;
      if (DATE_LIKE.test(cell)) date++;
      else if (NUMERIC_LIKE.test(cell)) numeric++;
      if (distinct.size <= 64) distinct.add(cell);
    }

    if (filled === 0) {
      shape.numeric++;  // an empty column costs the least; it gets dropped anyway
      continue;
    }
    if (date / filled >= 0.9) shape.date++;
    else if (numeric / filled >= 0.8) shape.numeric++;
    else if (distinct.size <= 50 && distinct.size * 2 <= filled) shape.categorical++;
    else {
      shape.text++;
      for (const row of rows) {
        const cell = (row[j] ?? '').trim();
        if (cell === '') continue;
        textLengthTotal += cell.length;
        textCells++;
      }
    }
  }

  shape.averageTextLength = textCells > 0 ? textLengthTotal / textCells : 0;
  return shape;
}

// ── Memory model ──────────────────────────────────────────────────────────────

/**
 * Bytes the global duplicate table will occupy for `rows` rows.
 *
 * This is not an approximation of the data structure — it *is* the data
 * structure. `RowHashSet` keeps one 64-bit hash per slot in a flat array whose
 * length is a power of two, and doubles when the load factor would pass 0.75.
 * Rounding to the next power of two matters: 4 M rows and 6 M rows both land on
 * 8 M slots, while 6.1 M rows lands on 16 M and doubles the cost.
 */
export function estimateDuplicateMemory(rows: number): number {
  if (rows <= 0) return 0;
  const needed = rows / DUPLICATE_LOAD_FACTOR;
  let slots = 1024;
  while (slots < needed) slots *= 2;
  return slots * DUPLICATE_BYTES_PER_SLOT;
}

/** Bytes the materialised columns will occupy for `rows` rows. */
export function estimateColumnMemory(rows: number, shape: ColumnShapeGuess): number {
  const textBytes =
    shape.text * (TEXT_STRING_OVERHEAD_BYTES + Math.ceil(shape.averageTextLength));
  return (
    rows *
    (shape.numeric * BYTES_PER_NUMERIC_ROW +
      shape.date * BYTES_PER_DATE_ROW +
      shape.categorical * BYTES_PER_CATEGORICAL_ROW +
      textBytes)
  );
}

/**
 * Peak heap for one mode. Everything is multiplied by the measured allocator
 * overhead, because the sum of the container sizes is not what the heap
 * actually reaches.
 */
export function estimateModeMemory(mode: ProcessingMode, file: FileEstimate): number {
  const rows = file.estimatedRows;
  // Even a pure scan needs the module, the chunk buffer and the type-inference
  // sample. Measured at 16 MB, which is Emscripten's default initial heap: the
  // memory never had to grow at all.
  const base = 16 * 1024 * 1024;

  if (mode === 'basic-scan') return base;

  const columns = estimateColumnMemory(rows, file.shape) * WASM_ALLOCATOR_OVERHEAD;
  if (mode === 'standard-clean') return base + columns;

  const duplicates = estimateDuplicateMemory(rows);
  if (mode === 'global-duplicates') return base + columns + duplicates;

  // Full analysis additionally sorts one column at a time for the quantiles.
  return base + columns + duplicates + rows * BYTES_PER_SORTED_VALUE;
}

// ── Recommendations ───────────────────────────────────────────────────────────

const MODE_LABEL: Record<ProcessingMode, string> = {
  'basic-scan': 'Escaneo básico',
  'standard-clean': 'Limpieza estándar',
  'global-duplicates': 'Duplicados globales',
  'full-analysis': 'Análisis completo',
};

function formatMB(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  // Below a megabyte, rounding to MB shows "0 MB" for a real file.
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Inverts the memory model: the file size at which this mode would reach the
 * budget. Returns undefined for modes whose memory does not scale with rows —
 * saying "max 2 GB" for a streaming scan would be a limit we invented.
 */
function maxFileBytesFor(
  mode: ProcessingMode,
  file: FileEstimate,
  budgetBytes: number
): number | undefined {
  if (mode === 'basic-scan') return undefined;
  const perRow = estimateModeMemory(mode, { ...file, estimatedRows: 1_000_000 }) / 1_000_000;
  if (!Number.isFinite(perRow) || perRow <= 0) return undefined;
  const rowsThatFit = budgetBytes / perRow;
  const bytes = rowsThatFit * file.averageRowBytes;
  return Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : undefined;
}

export function recommendForMode(
  mode: ProcessingMode,
  file: FileEstimate,
  budget: MemoryBudget
): ProcessingRecommendation {
  const estimated = estimateModeMemory(mode, file);
  const ratio = estimated / budget.targetMemoryBytes;
  const seconds = file.fileBytes / WASM_THROUGHPUT_BYTES_PER_SECOND;

  const recommendedMaxFileBytes = maxFileBytesFor(mode, file, budget.targetMemoryBytes);
  const warningThresholdBytes = maxFileBytesFor(
    mode,
    file,
    budget.targetMemoryBytes * WARNING_THRESHOLDS.warning
  );

  // A hard limit only exists where a real technical ceiling does: the point at
  // which the projection runs past what wasm32 can be asked to allocate.
  const hardLimitBytes =
    mode === 'basic-scan' ? undefined : maxFileBytesFor(mode, file, WASM_PLANNING_LIMIT_BYTES);

  let status: ProcessingStatus;
  let reason: string;

  if (mode === 'basic-scan') {
    status = 'safe';
    reason =
      `${MODE_LABEL[mode]} no guarda nada por fila: la memoria es de unos ` +
      `${formatMB(estimated)} sin importar el tamaño del archivo. No hay límite ` +
      'de tamaño por memoria, solo el tiempo que lleve leerlo.';
  } else if (estimated > WASM_PLANNING_LIMIT_BYTES * HARD_BLOCK_MULTIPLIER) {
    status = 'blocked';
    reason =
      `La estimación son ${formatMB(estimated)}, por encima de lo que wasm32 puede ` +
      `direccionar de forma confiable (${formatMB(WASM_PLANNING_LIMIT_BYTES)}). ` +
      'Este es un límite técnico real, no una recomendación. Probá con escaneo básico.';
  } else if (ratio > WARNING_THRESHOLDS.notRecommended) {
    status = 'not-recommended';
    reason =
      `La estimación son ${formatMB(estimated)} contra un presupuesto de ` +
      `${formatMB(budget.targetMemoryBytes)}. Se puede intentar igual, pero es ` +
      'probable que la pestaña quede sin memoria.';
  } else if (ratio > WARNING_THRESHOLDS.warning) {
    status = 'warning';
    reason =
      `La estimación son ${formatMB(estimated)}, cerca del presupuesto de ` +
      `${formatMB(budget.targetMemoryBytes)}. Debería andar, con poco margen.`;
  } else {
    status = 'safe';
    reason = `La estimación son ${formatMB(estimated)}, holgado dentro del presupuesto de ${formatMB(budget.targetMemoryBytes)}.`;
  }

  if (mode === 'global-duplicates') {
    reason +=
      ` La tabla de hashes sola son ${formatMB(estimateDuplicateMemory(file.estimatedRows))} ` +
      `para ~${file.estimatedRows.toLocaleString('es-AR')} filas.`;
  }

  return {
    mode,
    status,
    recommendedMaxFileBytes,
    warningThresholdBytes,
    hardLimitBytes,
    estimatedMemoryBytes: Math.round(estimated),
    estimatedSeconds: seconds,
    reason,
  };
}

export const ALL_MODES: ProcessingMode[] = [
  'basic-scan',
  'standard-clean',
  'global-duplicates',
  'full-analysis',
];

export async function preflight(
  file: Blob,
  budget: MemoryBudget,
  sampleBytes?: number
): Promise<PreflightResult> {
  const estimate = await estimateFile(file, sampleBytes);
  const recommendations = {} as Record<ProcessingMode, ProcessingRecommendation>;
  for (const mode of ALL_MODES) {
    recommendations[mode] = recommendForMode(mode, estimate, budget);
  }

  // Most capable mode that still reads as safe. Basic scan always qualifies.
  let recommendedMode: ProcessingMode = 'basic-scan';
  for (const mode of ALL_MODES) {
    if (recommendations[mode].status === 'safe') recommendedMode = mode;
  }

  return { file: estimate, budget, recommendations, recommendedMode };
}

export { MODE_LABEL, formatMB };
