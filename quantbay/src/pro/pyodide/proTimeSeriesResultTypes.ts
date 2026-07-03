// Tipos y normalización para los diagnósticos de series de tiempo de ChartBay
// Pro (statsmodels vía Pyodide). Es el análogo de proResultTypes.ts para el
// bloque de series de tiempo: define el contrato de entrada/salida del runner y
// convierte el JSON crudo que devuelve el script de Python en un resultado
// tipado y validado, sin lanzar nunca excepciones.
//
// Alcance intencional: SÓLO diagnósticos (ADF, ACF, PACF, Ljung-Box). ARIMA NO
// está implementado — el terreno queda preparado, pero cualquier intento de
// usar ARIMA se comunica honestamente en la UI (ver ui/proTimeSeriesView.ts) y
// nunca se finge un resultado.

// Término determinístico del test ADF (statsmodels adfuller regression=...):
//   c   → constante (default)
//   ct  → constante + tendencia
//   ctt → constante + tendencia + tendencia cuadrática
//   n   → sin término determinístico
export type ProAdfRegression = 'c' | 'ct' | 'ctt' | 'n';

export const PRO_ADF_REGRESSIONS: readonly ProAdfRegression[] = ['c', 'ct', 'ctt', 'n'];

export const DEFAULT_PRO_ADF_REGRESSION: ProAdfRegression = 'c';

export const PRO_ADF_REGRESSION_LABELS: Record<ProAdfRegression, string> = {
  c: 'constante (c)',
  ct: 'constante + tendencia (ct)',
  ctt: 'constante + tendencia + tendencia² (ctt)',
  n: 'sin término determinístico (n)',
};

export function isProAdfRegression(value: unknown): value is ProAdfRegression {
  return value === 'c' || value === 'ct' || value === 'ctt' || value === 'n';
}

// Entrada del runner: una serie numérica ya extraída de una columna del CSV
// (los valores no finitos se limpian en la validación TS, ver
// proTimeSeriesValidation.ts) más las opciones de diagnóstico.
export interface PyodideTimeSeriesInput {
  values: number[];
  variableName: string;
  maxLag?: number;
  adfRegression?: ProAdfRegression;
  // Rezagos para Ljung-Box. Por defecto la validación usa 1..maxLag.
  ljungBoxLags?: number[];
}

// H0 del ADF: la serie tiene raíz unitaria (no es estacionaria).
export interface ProAdfResult {
  // null cuando statsmodels devuelve un valor no finito (caso degenerado).
  statistic: number | null;
  pValue: number | null;
  usedLag: number;
  nobs: number;
  criticalValues: Record<string, number>;
  // Mejor criterio de información (AIC) del autolag, si statsmodels lo devuelve.
  icBest: number | null;
  // Derivado en TS a partir de pValue (< 0.05), única fuente de verdad.
  rejectAt5: boolean;
  interpretation: string;
}

export interface ProAcfPoint {
  lag: number;
  value: number;
}

export interface ProLjungBoxRow {
  lag: number;
  statistic: number;
  // null cuando statsmodels devuelve un p-value no finito para ese rezago.
  pValue: number | null;
  // Derivado en TS a partir de pValue (< 0.05).
  rejectAt5: boolean;
  interpretation: string;
}

export interface PyodideTimeSeriesResult {
  ok: boolean;
  engine: 'pyodide';
  variableName?: string;
  observations?: number;
  adfRegression?: ProAdfRegression;
  maxLag?: number;
  // Cada diagnóstico puede faltar si statsmodels falló SÓLO en ese cálculo — en
  // ese caso queda ausente y el motivo aparece en warnings, sin abortar el resto.
  adf?: ProAdfResult;
  acf?: ProAcfPoint[];
  pacf?: ProAcfPoint[];
  ljungBox?: ProLjungBoxRow[];
  warnings: string[];
  error?: string;
}

export function tsError(message: string): PyodideTimeSeriesResult {
  return { ok: false, engine: 'pyodide', warnings: [], error: message };
}

// ── Interpretaciones pedagógicas (derivadas del p-value de statsmodels) ───────
// Se calculan en TS, no en Python, para que:
//   1. rejectAt5 tenga una única fuente de verdad (el p-value numérico), y
//   2. los textos que ve el usuario se puedan testear sin cargar Pyodide.

export function adfRejectsAt5(pValue: number | null): boolean {
  return pValue !== null && pValue < 0.05;
}

export function interpretAdf(pValue: number | null): string {
  if (pValue === null) {
    return (
      'H0: la serie tiene raíz unitaria (no es estacionaria). El p-value no está disponible; ' +
      'compará el estadístico contra los valores críticos.'
    );
  }
  if (pValue < 0.05) {
    return 'Se rechaza H0 al 5%: hay evidencia de estacionariedad (la serie no tendría raíz unitaria).';
  }
  return 'No se rechaza H0 al 5%: la serie podría no ser estacionaria (posible raíz unitaria).';
}

export function ljungBoxRejectsAt5(pValue: number | null): boolean {
  return pValue !== null && pValue < 0.05;
}

export function interpretLjungBox(pValue: number | null): string {
  if (pValue === null) {
    return 'p-value no disponible para este rezago.';
  }
  if (pValue < 0.05) {
    return 'Se rechaza H0 al 5%: hay evidencia de autocorrelación hasta este rezago.';
  }
  return 'No se rechaza H0 al 5%: sin evidencia de autocorrelación conjunta hasta este rezago.';
}

// statsmodels devuelve NaN/inf en casos degenerados; el script Python los
// serializa como null y acá se aceptan sólo null o un número finito.
function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function parseAcfPoints(raw: unknown): ProAcfPoint[] | null {
  if (!Array.isArray(raw)) return null;
  const points: ProAcfPoint[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const lag = record.lag;
    const value = finiteOrNull(record.value);
    if (typeof lag !== 'number' || !Number.isInteger(lag) || value === undefined || value === null) return null;
    points.push({ lag, value });
  }
  return points;
}

function parseCriticalValues(raw: unknown): Record<string, number> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const num = finiteOrNull(value);
    // Un valor crítico no finito se omite en vez de invalidar todo el ADF.
    if (typeof num === 'number') out[key] = num;
  }
  return out;
}

// null/undefined = "el ADF no se calculó para esta corrida" (statsmodels falló
// sólo en el ADF, ver warnings) → válido, deja adf: undefined. Cualquier otra
// cosa debe ser un objeto bien formado o se rechaza todo el payload.
function parseAdf(raw: unknown): { ok: true; value: ProAdfResult | undefined } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };

  const record = raw as Record<string, unknown>;
  const statistic = finiteOrNull(record.statistic);
  const pValue = finiteOrNull(record.pValue);
  if (statistic === undefined || pValue === undefined) return { ok: false };

  const usedLag = record.usedLag;
  const nobs = record.nobs;
  if (typeof usedLag !== 'number' || !Number.isInteger(usedLag)) return { ok: false };
  if (typeof nobs !== 'number' || !Number.isInteger(nobs) || nobs <= 0) return { ok: false };

  const criticalValues = parseCriticalValues(record.criticalValues);
  if (criticalValues === null) return { ok: false };

  const icBest = finiteOrNull(record.icBest);
  if (icBest === undefined) return { ok: false };

  return {
    ok: true,
    value: {
      statistic,
      pValue,
      usedLag,
      nobs,
      criticalValues,
      icBest,
      rejectAt5: adfRejectsAt5(pValue),
      interpretation: interpretAdf(pValue),
    },
  };
}

// Misma convención que parseAdf: null/undefined = no se calculó (warning),
// cualquier otra cosa debe ser un array bien formado.
function parseLjungBox(raw: unknown): { ok: true; value: ProLjungBoxRow[] | undefined } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(raw)) return { ok: false };

  const rows: ProLjungBoxRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return { ok: false };
    const record = item as Record<string, unknown>;
    const lag = record.lag;
    const statistic = finiteOrNull(record.statistic);
    const pValue = finiteOrNull(record.pValue);
    if (typeof lag !== 'number' || !Number.isInteger(lag)) return { ok: false };
    if (statistic === undefined || statistic === null) return { ok: false };
    if (pValue === undefined) return { ok: false };
    rows.push({
      lag,
      statistic,
      pValue,
      rejectAt5: ljungBoxRejectsAt5(pValue),
      interpretation: interpretLjungBox(pValue),
    });
  }
  return { ok: true, value: rows };
}

/**
 * Convierte el valor crudo de pyodide.runPythonAsync (se espera: un string JSON
 * producido por el script de statsmodels de series de tiempo) en un
 * PyodideTimeSeriesResult validado. Nunca lanza — un payload malformado se
 * transforma en ok:false con un mensaje claro.
 */
export function normalizePyodideTimeSeriesResult(raw: unknown): PyodideTimeSeriesResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return tsError('El motor Python no devolvió resultados.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return tsError('El motor Python devolvió un resultado ilegible (JSON inválido).');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return tsError('El motor Python devolvió un resultado con formato inesperado.');
  }

  const obj = parsed as Record<string, unknown>;
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  if (obj.ok !== true) {
    const error = typeof obj.error === 'string' && obj.error.trim() !== ''
      ? obj.error
      : 'Error desconocido en el motor Python.';
    return { ok: false, engine: 'pyodide', warnings, error };
  }

  if (typeof obj.variableName !== 'string' || obj.variableName.trim() === '') {
    return tsError('El motor Python devolvió un nombre de variable inválido.');
  }
  if (typeof obj.observations !== 'number' || !Number.isInteger(obj.observations) || obj.observations <= 0) {
    return tsError('El motor Python devolvió un número de observaciones inválido.');
  }

  let adfRegression: ProAdfRegression | undefined;
  if (obj.adfRegression !== undefined && obj.adfRegression !== null) {
    if (!isProAdfRegression(obj.adfRegression)) {
      return tsError('El motor Python devolvió un tipo de regresión ADF inválido.');
    }
    adfRegression = obj.adfRegression;
  }

  let maxLag: number | undefined;
  if (obj.maxLag !== undefined && obj.maxLag !== null) {
    if (typeof obj.maxLag !== 'number' || !Number.isInteger(obj.maxLag) || obj.maxLag < 1) {
      return tsError('El motor Python devolvió un rezago máximo inválido.');
    }
    maxLag = obj.maxLag;
  }

  const adfParsed = parseAdf(obj.adf);
  if (!adfParsed.ok) return tsError('El motor Python devolvió un test ADF inválido.');

  // acf/pacf: null/undefined = no se calculó (warning); array = debe ser válido.
  let acf: ProAcfPoint[] | undefined;
  if (obj.acf !== undefined && obj.acf !== null) {
    const parsedAcf = parseAcfPoints(obj.acf);
    if (parsedAcf === null) return tsError('El motor Python devolvió una ACF inválida.');
    acf = parsedAcf;
  }
  let pacf: ProAcfPoint[] | undefined;
  if (obj.pacf !== undefined && obj.pacf !== null) {
    const parsedPacf = parseAcfPoints(obj.pacf);
    if (parsedPacf === null) return tsError('El motor Python devolvió una PACF inválida.');
    pacf = parsedPacf;
  }

  const ljungBoxParsed = parseLjungBox(obj.ljungBox);
  if (!ljungBoxParsed.ok) return tsError('El motor Python devolvió un test Ljung-Box inválido.');

  return {
    ok: true,
    engine: 'pyodide',
    variableName: obj.variableName,
    observations: obj.observations,
    adfRegression,
    maxLag,
    adf: adfParsed.value,
    acf,
    pacf,
    ljungBox: ljungBoxParsed.value,
    warnings,
  };
}
