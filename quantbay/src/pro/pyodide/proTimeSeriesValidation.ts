// Validación TypeScript de la entrada de diagnósticos de series de tiempo Pro,
// ANTES de pagar el costo de cargar Pyodide/numpy/pandas/statsmodels. Es el
// análogo de proDomainCheck.ts / proCapability.ts para el bloque de series.
//
// Todo lo que se pueda decidir sin Python se decide acá: limpieza de valores no
// numéricos/faltantes, mínimo de observaciones, serie constante, y ajuste de
// maxLag / rezagos de Ljung-Box a límites razonables según n. El script de
// Python re-valida el mínimo y la serie constante como defensa en profundidad
// (ver pythonTimeSeriesRunner.ts), pero acá damos feedback inmediato y claro.

import {
  DEFAULT_PRO_ADF_REGRESSION,
  MAX_ARIMA_D,
  MAX_ARIMA_P,
  MAX_ARIMA_Q,
  MAX_FORECAST_STEPS,
  MIN_FORECAST_STEPS,
  isProAdfRegression,
  type ProAdfRegression,
  type ProArimaOrder,
  type PyodideTimeSeriesInput,
} from './proTimeSeriesResultTypes';

// Mínimo de observaciones válidas para que ADF/ACF/PACF/Ljung-Box tengan
// sentido. Debe mantenerse en sincronía con el chequeo del script de Python.
export const MIN_PRO_TS_OBSERVATIONS = 12;

// Tope duro de rezago máximo, independientemente de n (mismo criterio que el
// motor Lite: quantbay/src/timeseries/acf.ts HARD_MAX_LAG).
export const HARD_MAX_LAG = 40;

const DEFAULT_MAX_LAG = 12;

export interface ValidatedProTimeSeriesInput {
  values: number[];
  variableName: string;
  maxLag: number;
  adfRegression: ProAdfRegression;
  ljungBoxLags: number[];
  warnings: string[];
}

export type ProTimeSeriesValidation =
  | { ok: true; value: ValidatedProTimeSeriesInput }
  | { ok: false; error: string };

// PACF (Yule-Walker) sólo está definida para rezagos hasta ~50% de la muestra;
// statsmodels lanza si se pide más. Ese es el límite superior efectivo de maxLag.
function safeMaxLagFor(n: number): number {
  return Math.max(1, Math.min(HARD_MAX_LAG, Math.floor(n / 2) - 1));
}

/**
 * Valida y normaliza la entrada del runner de series de tiempo Pro.
 * Devuelve la serie ya limpia (sin no-finitos) más maxLag/ljungBoxLags
 * ajustados, o un error controlado con mensaje pedagógico.
 */
export function validateProTimeSeriesInput(input: PyodideTimeSeriesInput): ProTimeSeriesValidation {
  const warnings: string[] = [];

  const variableName = (input.variableName ?? '').trim();
  if (variableName === '') {
    return { ok: false, error: 'Seleccioná una columna de serie antes de correr los diagnósticos.' };
  }

  // Limpieza: se descartan valores no numéricos, faltantes o infinitos (misma
  // convención que el motor Lite: quantbay/src/timeseries/acf.ts).
  const raw = Array.isArray(input.values) ? input.values : [];
  const values = raw.filter(v => typeof v === 'number' && Number.isFinite(v));
  const dropped = raw.length - values.length;
  if (dropped > 0) {
    warnings.push(`Se descartaron ${dropped} observaciones no numéricas, faltantes o infinitas.`);
  }

  const n = values.length;
  if (n < MIN_PRO_TS_OBSERVATIONS) {
    return {
      ok: false,
      error:
        `La serie necesita suficientes observaciones válidas para calcular diagnósticos de series de tiempo ` +
        `(al menos ${MIN_PRO_TS_OBSERVATIONS}; hay ${n}).`,
    };
  }

  // Serie constante: ADF/ACF/PACF no tienen sentido (varianza nula).
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max - min === 0) {
    return {
      ok: false,
      error: 'La serie es constante; no se pueden calcular ADF/ACF/PACF de forma significativa.',
    };
  }

  const adfRegression = input.adfRegression ?? DEFAULT_PRO_ADF_REGRESSION;
  if (!isProAdfRegression(adfRegression)) {
    return {
      ok: false,
      error: `Tipo de regresión ADF inválido: "${String(adfRegression)}". Valores permitidos: c, ct, ctt, n.`,
    };
  }

  const upperBound = safeMaxLagFor(n);
  const requestedMaxLag = Number.isInteger(input.maxLag) ? (input.maxLag as number) : DEFAULT_MAX_LAG;
  let maxLag = requestedMaxLag;
  if (maxLag < 1) {
    maxLag = 1;
    warnings.push('El rezago máximo debe ser al menos 1; se usa 1.');
  }
  if (maxLag > upperBound) {
    warnings.push(
      `El rezago máximo es demasiado alto para la cantidad de observaciones disponibles ` +
      `(máximo razonable ${upperBound}); se usa ${upperBound}.`
    );
    maxLag = upperBound;
  }

  // Ljung-Box: por defecto se evalúa en cada rezago 1..maxLag (Q acumulado).
  // Si el usuario pide rezagos explícitos, se filtran los válidos (1..n-1) y se
  // recorta cualquiera por encima de maxLag para no exceder límites razonables.
  let ljungBoxLags: number[];
  if (Array.isArray(input.ljungBoxLags) && input.ljungBoxLags.length > 0) {
    const requested = input.ljungBoxLags;
    ljungBoxLags = Array.from(
      new Set(requested.filter(lag => Number.isInteger(lag) && lag >= 1 && lag <= maxLag))
    ).sort((a, b) => a - b);
    if (ljungBoxLags.length < requested.length) {
      warnings.push(`Se ajustaron los rezagos de Ljung-Box al rango válido 1..${maxLag}.`);
    }
    if (ljungBoxLags.length === 0) {
      ljungBoxLags = rangeInclusive(1, maxLag);
      warnings.push(`Ningún rezago de Ljung-Box era válido; se usa el rango 1..${maxLag}.`);
    }
  } else {
    ljungBoxLags = rangeInclusive(1, maxLag);
  }

  return {
    ok: true,
    value: { values, variableName, maxLag, adfRegression, ljungBoxLags, warnings },
  };
}

export type ProArimaValidation =
  | { ok: true; value: ProArimaOrder }
  | { ok: false; error: string };

/**
 * Valida un orden ARIMA(p,d,q) manual antes de correr Pyodide. NO bloquea los
 * diagnósticos ADF/ACF/PACF/Ljung-Box: el runner corre los diagnósticos igual y
 * usa este error sólo para la sección ARIMA (ver pythonTimeSeriesRunner.ts).
 *
 * @param n cantidad de observaciones válidas ya limpias de la serie.
 */
export function validateProArimaOrder(order: ProArimaOrder | undefined, n: number): ProArimaValidation {
  if (!order) {
    return { ok: false, error: 'Falta el orden ARIMA (p, d, q) para estimar el modelo.' };
  }
  const { p, d, q } = order;

  if (![p, d, q].every(v => typeof v === 'number' && Number.isInteger(v))) {
    return { ok: false, error: 'Los parámetros p, d y q deben ser enteros no negativos.' };
  }
  if (p < 0 || d < 0 || q < 0) {
    return { ok: false, error: 'Los parámetros p, d y q deben ser enteros no negativos.' };
  }
  if (p === 0 && d === 0 && q === 0) {
    return { ok: false, error: 'ARIMA(0,0,0) no aporta dinámica temporal. Elegí al menos p, d o q mayor que cero.' };
  }
  if (p > MAX_ARIMA_P || q > MAX_ARIMA_Q || d > MAX_ARIMA_D) {
    return {
      ok: false,
      error: `Para esta primera versión, usá p y q entre 0 y ${MAX_ARIMA_P}, y d entre 0 y ${MAX_ARIMA_D}.`,
    };
  }

  // Tras diferenciar d veces quedan n - d observaciones útiles; el modelo debe
  // tener margen para estimar p + q coeficientes (más constante y varianza).
  if (n - d < p + q + 2) {
    return {
      ok: false,
      error: 'La serie no tiene suficientes observaciones para estimar este ARIMA. Probá un orden más simple.',
    };
  }

  return { ok: true, value: { p, d, q } };
}

export type ProForecastStepsValidation =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Valida el horizonte de forecast ANTES de correr Pyodide. Igual que el orden
 * ARIMA, un horizonte inválido NO bloquea los diagnósticos ni el ARIMA en sí:
 * el runner estima el ARIMA igual y usa este error sólo para la sección de
 * forecast (ver pythonTimeSeriesRunner.ts).
 */
export function validateProForecastSteps(steps: number | undefined): ProForecastStepsValidation {
  if (steps === undefined || steps === null) {
    return { ok: false, error: 'Falta el horizonte de forecast (cantidad de períodos futuros).' };
  }
  if (typeof steps !== 'number' || !Number.isInteger(steps) || steps < MIN_FORECAST_STEPS) {
    return { ok: false, error: 'El horizonte de forecast debe ser un entero positivo.' };
  }
  if (steps > MAX_FORECAST_STEPS) {
    return {
      ok: false,
      error: `Para esta primera versión, usá un horizonte de hasta ${MAX_FORECAST_STEPS} períodos.`,
    };
  }
  return { ok: true, value: steps };
}

function rangeInclusive(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) out.push(i);
  return out;
}
