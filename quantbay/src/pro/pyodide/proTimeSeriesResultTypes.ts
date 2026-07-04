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

// Orden de un ARIMA manual: p (AR), d (diferenciación), q (MA). Auto-ARIMA
// (selección automática del orden) NO está implementado en esta fase.
export interface ProArimaOrder {
  p: number;
  d: number;
  q: number;
}

// Límites de la primera versión de ARIMA manual (ver proTimeSeriesValidation.ts).
export const MAX_ARIMA_P = 5;
export const MAX_ARIMA_D = 2;
export const MAX_ARIMA_Q = 5;

export const DEFAULT_ARIMA_ORDER: ProArimaOrder = { p: 1, d: 0, q: 1 };

// Horizonte de forecast: límites de la primera versión.
export const MIN_FORECAST_STEPS = 1;
export const MAX_FORECAST_STEPS = 60;
export const DEFAULT_FORECAST_STEPS = 12;

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
  // ARIMA manual opcional: sólo se estima cuando runArima === true.
  runArima?: boolean;
  arimaOrder?: ProArimaOrder;
  // Horizonte de forecast (períodos futuros). Sólo tiene efecto cuando
  // runArima === true — sin ARIMA estimado no hay forecast posible.
  forecastSteps?: number;
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

// Un coeficiente estimado del ARIMA (ej: ar.L1, ma.L1, const, sigma2).
export interface ProArimaCoefficient {
  name: string;
  estimate: number | null;
  standardError: number | null;
  zStatistic: number | null;
  pValue: number | null;
}

// Ljung-Box sobre los residuos del ARIMA: si no rechaza, el modelo capturó
// razonablemente la dependencia temporal.
export interface ProArimaResidualDiagnostics {
  ljungBox: ProLjungBoxRow[];
  interpretation: string;
}

// Un paso del forecast: t+step. mean/lower/upper son null cuando statsmodels
// devuelve valores no finitos — nunca se inventan intervalos.
export interface ProArimaForecastItem {
  step: number;
  mean: number | null;
  // undefined cuando la versión de statsmodels no expone el SE del pronóstico.
  meanStandardError?: number | null;
  lower: number | null;
  upper: number | null;
}

export interface ProArimaForecast {
  steps: number;
  items: ProArimaForecastItem[];
  // Nivel de confianza de los intervalos (summary_frame usa alpha=0.05 → 0.95).
  confidenceLevel: number;
  warnings: string[];
}

export interface ProArimaResult {
  order: ProArimaOrder;
  // undefined cuando statsmodels no expone info de convergencia (no se inventa).
  converged?: boolean;
  nobs?: number;
  logLikelihood: number | null;
  aic: number | null;
  bic: number | null;
  hqic: number | null;
  coefficients: ProArimaCoefficient[];
  // Warnings de statsmodels capturados durante fit() (convergencia, etc.).
  warnings: string[];
  interpretation: string;
  // Forecast out-of-sample: presente sólo si se pidió y statsmodels pudo
  // generarlo. Si falla, forecastError explica por qué SIN borrar el ARIMA.
  forecast?: ProArimaForecast;
  forecastError?: string;
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
  // ARIMA manual: presente sólo cuando se estimó con éxito. Los diagnósticos de
  // arriba NUNCA dependen de ARIMA — si ARIMA falla, siguen presentes.
  arima?: ProArimaResult;
  // Presente cuando se pidió ARIMA pero falló (orden inválido o no estimable):
  // error controlado para la sección ARIMA, sin borrar los diagnósticos.
  arimaError?: string;
  arimaResidualDiagnostics?: ProArimaResidualDiagnostics;
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

export function interpretArima(order: ProArimaOrder, converged: boolean | undefined): string {
  const base =
    `ARIMA(${order.p},${order.d},${order.q}) combina términos autorregresivos AR(${order.p}), ` +
    `diferenciación d=${order.d} y media móvil MA(${order.q}). ` +
    `p: rezagos autorregresivos; d: cantidad de diferenciaciones; q: rezagos de errores de pronóstico.`;
  const diff = order.d > 0
    ? ' El modelo se estima sobre la serie diferenciada para reducir la no estacionariedad.'
    : '';
  const conv = converged === false
    ? ' El modelo no convergió. Probá un orden más simple o revisá la estacionariedad de la serie.'
    : '';
  return base + diff + conv;
}

export function interpretArimaResiduals(rows: ProLjungBoxRow[]): string {
  if (rows.length === 0) {
    return 'No se pudo evaluar la autocorrelación de los residuos del ARIMA.';
  }
  const anyReject = rows.some(row => row.rejectAt5);
  return anyReject
    ? 'Ljung-Box rechaza en algún rezago: queda autocorrelación en los residuos; considerá otro orden (p, d, q).'
    : 'Si Ljung-Box no rechaza autocorrelación en los residuos, el modelo capturó razonablemente la dependencia temporal.';
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

// Parsea un array de filas Ljung-Box (compartido por el LB de la serie y el LB
// de los residuos del ARIMA). Devuelve null si el array está malformado.
function parseLjungBoxRows(raw: unknown): ProLjungBoxRow[] | null {
  if (!Array.isArray(raw)) return null;
  const rows: ProLjungBoxRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const lag = record.lag;
    const statistic = finiteOrNull(record.statistic);
    const pValue = finiteOrNull(record.pValue);
    if (typeof lag !== 'number' || !Number.isInteger(lag)) return null;
    if (statistic === undefined || statistic === null) return null;
    if (pValue === undefined) return null;
    rows.push({
      lag,
      statistic,
      pValue,
      rejectAt5: ljungBoxRejectsAt5(pValue),
      interpretation: interpretLjungBox(pValue),
    });
  }
  return rows;
}

// Misma convención que parseAdf: null/undefined = no se calculó (warning),
// cualquier otra cosa debe ser un array bien formado.
function parseLjungBox(raw: unknown): { ok: true; value: ProLjungBoxRow[] | undefined } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  const rows = parseLjungBoxRows(raw);
  return rows === null ? { ok: false } : { ok: true, value: rows };
}

function parseArimaOrder(raw: unknown): ProArimaOrder | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { p, d, q } = record;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0) return null;
  if (typeof d !== 'number' || !Number.isInteger(d) || d < 0) return null;
  if (typeof q !== 'number' || !Number.isInteger(q) || q < 0) return null;
  return { p, d, q };
}

function parseArimaCoefficients(raw: unknown): ProArimaCoefficient[] | null {
  if (!Array.isArray(raw)) return null;
  const coefficients: ProArimaCoefficient[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== 'string') return null;
    const estimate = finiteOrNull(record.estimate);
    const standardError = finiteOrNull(record.standardError);
    const zStatistic = finiteOrNull(record.zStatistic);
    const pValue = finiteOrNull(record.pValue);
    // finiteOrNull devuelve undefined SÓLO para tipos no numéricos inesperados;
    // NaN/inf/null (casos degenerados) ya vienen como null y son válidos.
    if (estimate === undefined || standardError === undefined || zStatistic === undefined || pValue === undefined) {
      return null;
    }
    coefficients.push({ name: record.name, estimate, standardError, zStatistic, pValue });
  }
  return coefficients;
}

// Forecast es OPCIONAL dentro del ARIMA: null/undefined = no se pidió o falló
// (en ese caso forecastError explica por qué). Un objeto presente debe estar
// bien formado o se rechaza el ARIMA completo.
function parseArimaForecast(raw: unknown): { ok: true; value: ProArimaForecast | undefined } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };

  const record = raw as Record<string, unknown>;
  if (typeof record.steps !== 'number' || !Number.isInteger(record.steps) || record.steps < 1) return { ok: false };
  if (typeof record.confidenceLevel !== 'number' || !(record.confidenceLevel > 0 && record.confidenceLevel < 1)) {
    return { ok: false };
  }
  if (!Array.isArray(record.items)) return { ok: false };

  const items: ProArimaForecastItem[] = [];
  for (const item of record.items) {
    if (item === null || typeof item !== 'object') return { ok: false };
    const row = item as Record<string, unknown>;
    if (typeof row.step !== 'number' || !Number.isInteger(row.step) || row.step < 1) return { ok: false };
    const mean = finiteOrNull(row.mean);
    const lower = finiteOrNull(row.lower);
    const upper = finiteOrNull(row.upper);
    if (mean === undefined || lower === undefined || upper === undefined) return { ok: false };
    // meanStandardError puede faltar (versión de statsmodels sin SE) → undefined.
    let meanStandardError: number | null | undefined;
    if ('meanStandardError' in row && row.meanStandardError !== undefined) {
      meanStandardError = finiteOrNull(row.meanStandardError);
      if (meanStandardError === undefined) return { ok: false };
    }
    items.push({ step: row.step, mean, meanStandardError, lower, upper });
  }

  const forecastWarnings = Array.isArray(record.warnings)
    ? record.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  return {
    ok: true,
    value: { steps: record.steps, items, confidenceLevel: record.confidenceLevel, warnings: forecastWarnings },
  };
}

// ARIMA es OPCIONAL: null/undefined = no se pidió o no se estimó (válido).
// Un objeto presente debe estar bien formado o se rechaza todo el payload.
function parseArima(raw: unknown): { ok: true; value: ProArimaResult | undefined } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };

  const record = raw as Record<string, unknown>;
  const order = parseArimaOrder(record.order);
  if (order === null) return { ok: false };

  const coefficients = parseArimaCoefficients(record.coefficients);
  if (coefficients === null) return { ok: false };

  const logLikelihood = finiteOrNull(record.logLikelihood);
  const aic = finiteOrNull(record.aic);
  const bic = finiteOrNull(record.bic);
  const hqic = finiteOrNull(record.hqic);
  if (logLikelihood === undefined || aic === undefined || bic === undefined || hqic === undefined) return { ok: false };

  // converged: sólo boolean o ausente (no se inventa cuando statsmodels no lo expone).
  let converged: boolean | undefined;
  if (record.converged === true || record.converged === false) converged = record.converged;
  else if (record.converged !== null && record.converged !== undefined) return { ok: false };

  let nobs: number | undefined;
  if (record.nobs !== null && record.nobs !== undefined) {
    if (typeof record.nobs !== 'number' || !Number.isInteger(record.nobs) || record.nobs <= 0) return { ok: false };
    nobs = record.nobs;
  }

  const arimaWarnings = Array.isArray(record.warnings)
    ? record.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  const forecastParsed = parseArimaForecast(record.forecast);
  if (!forecastParsed.ok) return { ok: false };

  // forecastError: texto opcional de falla controlada del forecast.
  const forecastError = typeof record.forecastError === 'string' && record.forecastError.trim() !== ''
    ? record.forecastError
    : undefined;

  return {
    ok: true,
    value: {
      forecast: forecastParsed.value,
      forecastError,
      order,
      converged,
      nobs,
      logLikelihood,
      aic,
      bic,
      hqic,
      coefficients,
      warnings: arimaWarnings,
      interpretation: interpretArima(order, converged),
    },
  };
}

function parseArimaResidualDiagnostics(
  raw: unknown
): { ok: true; value: ProArimaResidualDiagnostics | undefined } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const record = raw as Record<string, unknown>;
  const rows = parseLjungBoxRows(record.ljungBox);
  if (rows === null) return { ok: false };
  return { ok: true, value: { ljungBox: rows, interpretation: interpretArimaResiduals(rows) } };
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

  const arimaParsed = parseArima(obj.arima);
  if (!arimaParsed.ok) return tsError('El motor Python devolvió un resultado ARIMA inválido.');

  const arimaResidualParsed = parseArimaResidualDiagnostics(obj.arimaResidualDiagnostics);
  if (!arimaResidualParsed.ok) {
    return tsError('El motor Python devolvió diagnósticos de residuos ARIMA inválidos.');
  }

  // arimaError es un texto opcional (falla controlada de ARIMA); ausente/no-string → undefined.
  const arimaError = typeof obj.arimaError === 'string' && obj.arimaError.trim() !== ''
    ? obj.arimaError
    : undefined;

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
    arima: arimaParsed.value,
    arimaError,
    arimaResidualDiagnostics: arimaResidualParsed.value,
    warnings,
  };
}
