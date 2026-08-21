import { forEachCellOf, getValidRows, getValidRowsFrom, type ParsedCSV } from '../csvParser';
import { computeVIF, runOLS, type RegressionResult } from '../regression';
import { pearsonMatrix } from '../statistics';

export interface LeakageSignal {
  name: string;
  r: number;
  abs: number;
}

export interface LogisticResult {
  intercept: number;
  coefficients: number[];
  oddsRatios: number[];
  mcFaddenR2: number;
  accuracy: number;
  llModel: number;
  llNull: number;
  featureNames: string[];
  yName: string;
  yVals: number[];
  n: number;
}

export interface AnalysisResult {
  result: RegressionResult;
  dropped: number;
  corrMatrix: number[][];
  corrColumns: string[];
  vifValues: number[];
  binary: boolean;
  leaks: LeakageSignal[];
  logitResult: LogisticResult | null;
}

export type AnalysisValidationIssueType =
  | 'missing_values'
  | 'invalid_numeric'
  | 'constant_column'
  | 'duplicate_column'
  | 'collinearity';

export interface AnalysisValidationIssue {
  type: AnalysisValidationIssueType;
  columns: string[];
  message: string;
  count?: number;
  correlation?: number;
}

/**
 * Decisiones que quien corre el modelo toma sobre los datos, y que la
 * validación no puede tomar por su cuenta.
 */
export interface AnalysisOptions {
  /**
   * Estimar excluyendo las filas con celdas vacías en las columnas del modelo
   * (listwise deletion, el default de Stata, R y statsmodels).
   *
   * El estimador SIEMPRE descartó esas filas —`getValidRowsFrom` las cuenta en
   * `dropped` y la UI las muestra como "Filas omitidas (NA)"—; lo único que
   * decide esta opción es si el hueco frena la estimación con un error o si es
   * una exclusión declarada. Por eso el default es `false`: que ChartBay no
   * saque filas sin que se lo pidan sigue siendo la política.
   */
  dropIncompleteRows?: boolean;
}

/** Casos completos de un modelo, tal como los devuelve `getValidRowsFrom`. */
export type CompleteCaseSample = { X: number[][]; y: number[]; dropped: number };

export class AnalysisValidationError extends Error {
  issues: AnalysisValidationIssue[];

  constructor(issues: AnalysisValidationIssue[]) {
    super(formatValidationMessage(issues));
    this.name = 'AnalysisValidationError';
    this.issues = issues;
  }
}

/**
 * Columnar form of getCompleteNumericColumns.
 *
 * Same result — the numeric columns restricted to rows where every one of them
 * is present — but read straight off the typed arrays. This feeds the
 * correlation matrix, which touches every value of every numeric column, so it
 * is one of the passes worth keeping off the row-object path.
 */
export function getCompleteNumericColumnsFrom(data: ParsedCSV): number[][] {
  if (!data.columns) return getCompleteNumericColumns(data.rows, data.numericColumns);

  const { numeric, rowCount } = data.columns;
  const cols = data.numericColumns.map(name => numeric.get(name));
  if (cols.some(col => !col)) {
    return getCompleteNumericColumns(data.rows, data.numericColumns);
  }

  const out: number[][] = cols.map(() => []);
  for (let i = 0; i < rowCount; i++) {
    let complete = true;
    for (const col of cols) {
      if (!col!.mask[i]) {
        complete = false;
        break;
      }
    }
    if (!complete) continue;
    for (let j = 0; j < cols.length; j++) out[j].push(cols[j]!.values[i]);
  }
  return out;
}

export function getCompleteNumericColumns(
  rows: Record<string, unknown>[],
  colNames: string[]
): number[][] {
  const valid = rows.filter(row =>
    colNames.every(c => {
      const raw = row[c];
      if (raw === null || raw === undefined || raw === '') return false;
      const v = Number(raw);
      return !isNaN(v) && isFinite(v);
    })
  );
  return colNames.map(col => valid.map(row => Number(row[col])));
}

const LEAK_THRESHOLD = 0.95;
const COLLINEARITY_THRESHOLD = 0.9999;
const EPS = 1e-12;

function isMissing(raw: unknown): boolean {
  return raw === null || raw === undefined || raw === '';
}

function isFiniteNumeric(raw: unknown): boolean {
  if (isMissing(raw)) return false;
  const value = Number(raw);
  return !isNaN(value) && isFinite(value);
}

function sameNumber(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= EPS * scale;
}

function isConstant(values: number[]): boolean {
  if (values.length <= 1) return true;
  return values.every(value => sameNumber(value, values[0]));
}

function formatValidationMessage(issues: AnalysisValidationIssue[]): string {
  const lines = issues.map(issue => `- ${issue.message}`);
  return [
    'No se pudo estimar el modelo porque el dataset necesita una revision antes de calcular.',
    ...lines,
    'Chart Bay no elimino ni modifico datos automaticamente.',
  ].join('\n');
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function sigmoid(z: number): number {
  if (z > 500) return 1;
  if (z < -500) return 0;
  return 1 / (1 + Math.exp(-z));
}

function columnCorrelation(a: number[], b: number[]): number {
  const aMean = mean(a);
  const bMean = mean(b);
  let numerator = 0;
  let aDev2 = 0;
  let bDev2 = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - aMean;
    const db = b[i] - bMean;
    numerator += da * db;
    aDev2 += da * da;
    bDev2 += db * db;
  }
  const denominator = Math.sqrt(aDev2 * bDev2);
  return denominator === 0 ? 0 : numerator / denominator;
}

function hasRankDeficiency(matrix: number[][]): boolean {
  if (matrix.length === 0 || matrix[0].length === 0) return false;
  const n = matrix.length;
  const p = matrix[0].length;
  const cols = Array.from({ length: p }, (_, col) => matrix.map(row => row[col]));
  const maxNorm = Math.max(...cols.map(col => Math.sqrt(col.reduce((sum, value) => sum + value * value, 0))));
  const threshold = 1e-10 * Math.sqrt(n) * Math.max(1, maxNorm);
  const basis: number[][] = [];

  for (const col of cols) {
    let residual = col.slice();
    for (const vector of basis) {
      const projection = vector.reduce((sum, value, index) => sum + value * residual[index], 0);
      residual = residual.map((value, index) => value - projection * vector[index]);
    }
    const norm = Math.sqrt(residual.reduce((sum, value) => sum + value * value, 0));
    if (norm < threshold) return true;
    basis.push(residual.map(value => value / norm));
  }

  return false;
}

export function validateAnalysisInput(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  options: AnalysisOptions = {},
  // Reutiliza la submuestra cuando quien llama ya la calculó. getValidRowsFrom
  // arma la matriz de diseño entera (O(n·k) y una fila de JS por observación),
  // que es justo el costo que el camino columnar existe para pagar una sola vez.
  precomputedSample?: CompleteCaseSample
): AnalysisValidationIssue[] {
  const selected = [yName, ...xNames];
  const issues: AnalysisValidationIssue[] = [];

  const sample = precomputedSample ?? getValidRowsFrom(csvData, yName, xNames);
  // Listwise sólo puede "declarar" la exclusión si queda algo que estimar. Si
  // no sobrevive ninguna fila completa, el hueco vuelve a ser el problema a
  // reportar; si no, el mensaje que saldría es que la columna es constante.
  const listwise = options.dropIncompleteRows === true && sample.y.length > 0;

  for (const col of selected) {
    let missing = 0;
    let invalid = 0;
    // forEachCellOf y no `csvData.rows`: en el camino columnar `rows` es la
    // vista previa, así que contar ahí decidía si el modelo se podía estimar
    // mirando 50 filas. Un hueco en la fila 80 de un archivo de 150 pasaba
    // desapercibido, y una columna de fecha —número en el store, string ISO en
    // la previa— se rechazaba como no numérica.
    forEachCellOf(csvData, col, raw => {
      if (isMissing(raw)) {
        missing++;
      } else if (!isFiniteNumeric(raw)) {
        invalid++;
      }
    });

    // Con listwise declarado, un hueco deja de ser un error: el estimador ya
    // descarta esas filas y las cuenta en `dropped`, así que frenar acá sólo
    // obligaría a limpiar el archivo para llegar al mismo modelo.
    if (missing > 0 && !listwise) {
      issues.push({
        type: 'missing_values',
        columns: [col],
        count: missing,
        message: `"${col}" tiene ${missing} valor(es) faltante(s). Completa esas celdas o filtra esas filas antes de estimar; una celda vacia cambia el modelo que se puede calcular.`,
      });
    }

    if (invalid > 0) {
      issues.push({
        type: 'invalid_numeric',
        columns: [col],
        count: invalid,
        message: `"${col}" tiene ${invalid} valor(es) con texto o formato no numerico. Revisa separadores, simbolos y celdas con texto; por ejemplo, usa 1234.56 en vez de texto mezclado con numeros.`,
      });
    }
  }

  if (issues.length > 0) return issues;

  // Constancia, duplicados y colinealidad se miran sobre la MISMA submuestra de
  // casos completos que va a estimar el modelo, y sobre el dataset entero.
  // Antes esto leía `csvData.rows`: además de quedarse con la vista previa,
  // una celda vacía entraba como Number('') === 0 y ensuciaba la correlación
  // con ceros que no existen.
  const columns = new Map<string, number[]>([
    [yName, sample.y],
    ...xNames.map((name, j) => [name, sample.X.map(row => row[j])] as [string, number[]]),
  ]);

  for (const col of selected) {
    const values = columns.get(col) ?? [];
    if (isConstant(values)) {
      issues.push({
        type: 'constant_column',
        columns: [col],
        message: `"${col}" es constante: todos sus valores son iguales. Una columna sin variacion no aporta informacion al modelo; elegi otra variable o agrega datos con cambios reales.`,
      });
    }
  }

  for (let i = 0; i < xNames.length; i++) {
    for (let j = i + 1; j < xNames.length; j++) {
      const aName = xNames[i];
      const bName = xNames[j];
      const a = columns.get(aName) ?? [];
      const b = columns.get(bName) ?? [];
      if (a.length === b.length && a.every((value, index) => sameNumber(value, b[index]))) {
        issues.push({
          type: 'duplicate_column',
          columns: [aName, bName],
          message: `"${aName}" y "${bName}" son columnas duplicadas: tienen los mismos valores fila por fila. Usa solo una de ellas para evitar contar la misma informacion dos veces.`,
        });
      }
    }
  }

  for (let i = 0; i < xNames.length; i++) {
    for (let j = i + 1; j < xNames.length; j++) {
      const aName = xNames[i];
      const bName = xNames[j];
      const a = columns.get(aName) ?? [];
      const b = columns.get(bName) ?? [];
      if (isConstant(a) || isConstant(b)) continue;
      const r = columnCorrelation(a, b);
      if (Math.abs(r) >= COLLINEARITY_THRESHOLD) {
        issues.push({
          type: 'collinearity',
          columns: [aName, bName],
          correlation: r,
          message: `"${aName}" y "${bName}" tienen colinealidad casi perfecta (r = ${r.toFixed(6)}). Se mueven practicamente igual, entonces el modelo no puede separar sus efectos. Elegi una de las dos o transforma las variables antes de estimar.`,
        });
      }
    }
  }

  if (issues.length === 0 && xNames.length > 1) {
    const design = sample.X.map(row => [1, ...row]);
    if (hasRankDeficiency(design)) {
      issues.push({
        type: 'collinearity',
        columns: xNames,
        message: 'Las variables X seleccionadas tienen colinealidad perfecta o casi perfecta como conjunto. En simple: una variable puede reconstruirse con otras, y la matriz queda singular. Revisa si una columna es combinacion lineal de otras antes de estimar.',
      });
    }
  }

  return issues;
}

export function isBinaryTarget(y: number[]): boolean {
  return new Set(y).size === 2;
}

export function detectLeakage(
  X: number[][],
  y: number[],
  xNames: string[],
  threshold = LEAK_THRESHOLD
): LeakageSignal[] {
  const yMean = mean(y);
  const yDev = y.map(value => value - yMean);
  const yVar = yDev.reduce((sum, value) => sum + value * value, 0);

  return xNames
    .map((name, index) => {
      const xCol = X.map(row => row[index]);
      const xMean = mean(xCol);
      const xDev = xCol.map(value => value - xMean);
      const numerator = xDev.reduce((sum, value, rowIndex) => sum + value * yDev[rowIndex], 0);
      const denominator = Math.sqrt(xDev.reduce((sum, value) => sum + value * value, 0) * yVar);
      const r = denominator === 0 ? 0 : numerator / denominator;
      return { name, r, abs: Math.abs(r) };
    })
    .filter(signal => signal.abs >= threshold);
}

export function runLogistic({
  X,
  y,
  featureNames,
  yName,
  maxIter = 1500,
  lr = 0.05,
}: {
  X: number[][];
  y: number[];
  featureNames: string[];
  yName: string;
  maxIter?: number;
  lr?: number;
}): LogisticResult {
  const n = y.length;
  const yVals = [...new Set(y)].sort((a, b) => a - b);
  const yBin = y.map(value => (value === yVals[1] ? 1 : 0));
  const Xd = X.map(row => [1, ...row]);
  const p = Xd[0].length;

  let beta = new Array(p).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    const probs = Xd.map(row => sigmoid(dot(beta, row)));
    const errors = probs.map((prob, index) => prob - yBin[index]);
    const gradient = Array.from({ length: p }, (_, col) =>
      Xd.reduce((sum, row, rowIndex) => sum + row[col] * errors[rowIndex], 0) / n
    );
    beta = beta.map((value, index) => value - lr * gradient[index]);
  }

  const probs = Xd.map(row => sigmoid(dot(beta, row)));
  const eps = 1e-15;
  const llModel = probs.reduce(
    (sum, prob, index) =>
      sum +
      yBin[index] * Math.log(Math.max(eps, prob)) +
      (1 - yBin[index]) * Math.log(Math.max(eps, 1 - prob)),
    0
  );
  const pMean = mean(yBin);
  const llNull =
    n *
    (pMean * Math.log(Math.max(eps, pMean)) +
      (1 - pMean) * Math.log(Math.max(eps, 1 - pMean)));
  const predicted = probs.map(prob => (prob >= 0.5 ? 1 : 0));

  return {
    intercept: beta[0],
    coefficients: beta.slice(1),
    oddsRatios: beta.slice(1).map(coef => Math.exp(coef)),
    mcFaddenR2: llNull !== 0 ? Math.max(0, 1 - llModel / llNull) : 0,
    accuracy: predicted.filter((prediction, index) => prediction === yBin[index]).length / n,
    llModel,
    llNull,
    featureNames,
    yName,
    yVals,
    n,
  };
}

export function runQuantAnalysis(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  options: AnalysisOptions = {}
): AnalysisResult {
  const sample = getValidRowsFrom(csvData, yName, xNames);
  const validationIssues = validateAnalysisInput(csvData, yName, xNames, options, sample);
  if (validationIssues.length > 0) {
    throw new AnalysisValidationError(validationIssues);
  }

  const { X, y, dropped } = sample;
  if (y.length < xNames.length + 2) {
    throw new Error(`Observaciones insuficientes (${y.length}) para ${xNames.length} variable(s). Necesitas mas filas validas que parametros a estimar; agrega datos o usa menos variables X.`);
  }

  const result = runOLS({ X, y, featureNames: xNames, yName });
  // Versión columnar: la de filas resumía el dataset entero con las 50 de la
  // vista previa. autoRepair.ts ya usaba esta; este sitio quedó sin migrar, así
  // que "Calcular" y "Arreglar y calcular" mostraban correlaciones distintas.
  const allColData = getCompleteNumericColumnsFrom(csvData);
  const binary = isBinaryTarget(y);
  const leaks = detectLeakage(X, y, xNames);
  let logitResult: LogisticResult | null = null;

  if (binary) {
    try {
      logitResult = runLogistic({ X, y, featureNames: xNames, yName });
    } catch {
      logitResult = null;
    }
  }

  return {
    result,
    dropped,
    corrMatrix: pearsonMatrix(allColData),
    corrColumns: csvData.numericColumns,
    vifValues: computeVIF(X),
    binary,
    leaks,
    logitResult,
  };
}
