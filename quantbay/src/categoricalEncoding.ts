// Categorical variable support for ChartBay regression.
//
// A column selected as X is treated as categorical when at least one of its
// non-missing values is not numeric. Categorical X columns are expanded into
// k-1 dummy columns (dummy trap avoidance): one category — the alphabetically
// first — becomes the omitted base category.
//
// Y is never encoded: a categorical Y is a hard error (see assertNumericY).

import { materializeRows, type ParsedCSV } from './csvParser';

export interface CategoricalVariableInfo {
  originalName: string;
  baseCategory: string;
  createdDummies: string[];
  categories: string[];
}

export interface DummyEncodingResult {
  rows: Record<string, unknown>[];
  expandedXNames: string[];
  categoricalInfo: CategoricalVariableInfo[];
  warnings: string[];
}

const MISSING_CATEGORY_LABEL = 'Sin_dato';
const MANY_CATEGORIES_THRESHOLD = 20;

function isMissing(raw: unknown): boolean {
  return raw === null || raw === undefined || String(raw).trim() === '';
}

function isNumericValue(raw: unknown): boolean {
  return !isNaN(Number(raw)) && isFinite(Number(raw));
}

// A column is categorical when it has at least one non-missing value that
// cannot be parsed as a number. Missing-only or fully-numeric columns are not.
export function isCategoricalColumn(rows: Record<string, unknown>[], column: string): boolean {
  return rows.some(row => {
    const raw = row[column];
    if (isMissing(raw)) return false;
    return !isNumericValue(raw);
  });
}

// Columns eligible to appear as selectable X candidates but not already
// classified as numeric: non-numeric headers with at least one categorical value.
export function detectCategoricalColumns(
  rows: Record<string, unknown>[],
  headers: string[],
  numericColumns: string[]
): string[] {
  const numericSet = new Set(numericColumns);
  return headers.filter(h => !numericSet.has(h) && isCategoricalColumn(rows, h));
}

export function assertNumericY(rows: Record<string, unknown>[], yName: string): void {
  if (isCategoricalColumn(rows, yName)) {
    throw new Error(
      'La variable dependiente Y debe ser numérica. Las variables categóricas solo pueden usarse como explicativas X mediante dummies.'
    );
  }
}

const DIACRITIC_MARKS = /[̀-ͯ]/g;

function sanitizeToken(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(DIACRITIC_MARKS, '') // strip diacritics: Tecnología -> Tecnologia
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
}

// The sanitized "originalName_category" token a dummy would use, before
// collision-suffix resolution. Exported so callers that only have a category
// label (e.g. Pro's RLS error messages, matching a restriction against the
// omitted base category) can recognize the same token without recreating the
// sanitization rules.
export function dummyBaseName(originalName: string, category: string): string {
  const base = `${sanitizeToken(originalName)}_${sanitizeToken(category)}`;
  return base.replace(/^_+|_+$/g, '') || `${sanitizeToken(originalName) || 'var'}_cat`;
}

function buildDummyName(originalName: string, category: string, used: Set<string>): string {
  const safeBase = dummyBaseName(originalName, category);

  let candidate = safeBase;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${safeBase}_${suffix}`;
    suffix++;
  }
  used.add(candidate);
  return candidate;
}

function categoryLabel(raw: unknown): string {
  return isMissing(raw) ? MISSING_CATEGORY_LABEL : String(raw).trim();
}

// Expand categorical X columns into k-1 dummy columns. Numeric X columns pass
// through unchanged. Does not mutate the input rows.
export function encodeCategoricalX(
  rows: Record<string, unknown>[],
  xNames: string[]
): DummyEncodingResult {
  const categoricalInfo: CategoricalVariableInfo[] = [];
  const warnings: string[] = [];
  const expandedXNames: string[] = [];
  const usedDummyNames = new Set<string>(xNames);
  let workingRows: Record<string, unknown>[] = rows.map(row => ({ ...row }));

  for (const xName of xNames) {
    if (!isCategoricalColumn(rows, xName)) {
      expandedXNames.push(xName);
      continue;
    }

    const rawLabels = rows.map(row => categoryLabel(row[xName]));
    const categories = Array.from(new Set(rawLabels)).sort();

    if (categories.length <= 1) {
      warnings.push(`La variable "${xName}" tiene una sola categoría y no aporta variación al modelo.`);
      continue;
    }

    if (categories.length > MANY_CATEGORIES_THRESHOLD) {
      warnings.push(
        `La variable "${xName}" tiene muchas categorías (${categories.length}). Esto puede aumentar mucho la cantidad de regresores y reducir grados de libertad.`
      );
    }

    const baseCategory = categories[0];
    const nonBaseCategories = categories.slice(1);
    const createdDummies = nonBaseCategories.map(cat => buildDummyName(xName, cat, usedDummyNames));

    workingRows = workingRows.map((row, i) => {
      const label = rawLabels[i];
      const updated = { ...row };
      nonBaseCategories.forEach((cat, idx) => {
        updated[createdDummies[idx]] = label === cat ? 1 : 0;
      });
      return updated;
    });

    expandedXNames.push(...createdDummies);
    categoricalInfo.push({ originalName: xName, baseCategory, createdDummies, categories });
  }

  return { rows: workingRows, expandedXNames, categoricalInfo, warnings };
}

/**
 * Prepara el dataset para la codificación de dummies.
 *
 * En el camino columnar `csvData.rows` es solo la vista previa, así que
 * codificar contra él estimaría el modelo sobre 50 filas en silencio. Cuando no
 * hay categóricas —el caso común— no hace falta tocar nada y el store columnar
 * sigue entero. Cuando sí las hay, se materializan las filas (O(n), deliberado)
 * y se descarta `columns`: las dummies nuevas viven solo en `encoding.rows`, y
 * dejar el store viejo haría que getValidRowsFrom leyera los datos previos a la
 * codificación e ignorara cada dummy.
 */
export function encodeForRegression(
  csvData: ParsedCSV,
  xNames: string[]
): { encoding: ReturnType<typeof encodeCategoricalX>; effectiveCsvData: ParsedCSV } {
  const sourceRows = csvData.columns ? materializeRows(csvData) : csvData.rows;
  const encoding = encodeCategoricalX(sourceRows, xNames);

  if (encoding.categoricalInfo.length === 0 && csvData.columns) {
    // Sin dummies no cambió ninguna columna: se conserva el store columnar y la
    // regresión sigue leyendo arrays tipados.
    return { encoding, effectiveCsvData: csvData };
  }
  return {
    encoding,
    effectiveCsvData: {
      ...csvData,
      rows: encoding.rows,
      rowCount: encoding.rows.length,
      columns: undefined,
    },
  };
}
