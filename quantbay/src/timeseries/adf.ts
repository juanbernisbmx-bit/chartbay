import { fitOlsQr } from '../qrLeastSquares';

export interface ADFCriticalValues {
  onePercent: number;
  fivePercent: number;
  tenPercent: number;
}

export type ADFResult =
  | {
      available: true;
      observations: number;
      /** n de la regresión ADF: menor que `observations` por diferenciar y rezagar. */
      regressionObservations: number;
      lag: number;
      statistic: number;
      pValue: null;
      criticalValues: ADFCriticalValues;
      verdict: string;
      interpretation: string;
    }
  | {
      available: false;
      observations: number;
      lag: number | null;
      statistic: null;
      pValue: null;
      criticalValues: ADFCriticalValues;
      verdict: string;
      interpretation: string;
      reason: string;
    };

const EPSILON = 1e-12;
const MIN_OBSERVATIONS = 8;

/**
 * Valores críticos de MacKinnon (2010) para la regresión con constante
 * (N = 1, reg = "c"), que es la única forma que estima computeADF.
 *
 * Cada nivel es un polinomio en 1/n:  crit(n) = b0 + b1/n + b2/n² + b3/n³.
 * El término b0 es el valor asintótico, y es lo que la app usaba fijo: -3.43,
 * -2.86 y -2.57. Con muestras chicas eso es demasiado permisivo, porque la
 * distribución de Dickey-Fuller tiene la cola más pesada cuanto menor es n.
 * Con las 60 observaciones que deja un IPC de 72 meses con lag 11, el crítico
 * al 5% es -2.91 y no -2.86: un estadístico entre esos dos valores se leía
 * como rechazo de la raíz unitaria cuando no lo es.
 *
 * Es la misma superficie que statsmodels.tsa.adfvalues.mackinnoncrit,
 * verificada dígito por dígito contra ella.
 */
const MACKINNON_C: Record<keyof ADFCriticalValues, readonly [number, number, number, number]> = {
  onePercent: [-3.43035, -6.5393, -16.786, -79.433],
  fivePercent: [-2.86154, -2.8903, -4.234, -40.04],
  tenPercent: [-2.56677, -1.5384, -2.809, 0],
};

/**
 * `regressionObservations` es el n de la REGRESIÓN ADF, no el largo de la
 * serie: después de diferenciar y de descartar las filas que se comen los
 * rezagos quedan menos. Es el mismo n que le pasa statsmodels.
 */
export function adfCriticalValues(regressionObservations: number): ADFCriticalValues {
  const evaluate = (c: readonly [number, number, number, number]): number => {
    if (!Number.isFinite(regressionObservations) || regressionObservations <= 0) return c[0];
    const inv = 1 / regressionObservations;
    return c[0] + c[1] * inv + c[2] * inv * inv + c[3] * inv * inv * inv;
  };
  return {
    onePercent: evaluate(MACKINNON_C.onePercent),
    fivePercent: evaluate(MACKINNON_C.fivePercent),
    tenPercent: evaluate(MACKINNON_C.tenPercent),
  };
}

/** Límite asintótico: lo único razonable cuando no hay regresión que contar. */
const ASYMPTOTIC_CRITICAL_VALUES = adfCriticalValues(Number.POSITIVE_INFINITY);

function automaticLag(observations: number): number {
  const schwertLag = Math.floor(12 * (observations / 100) ** 0.25);
  const maxAllowed = Math.max(0, Math.floor((observations - 4) / 2));
  return Math.min(schwertLag, maxAllowed);
}

function variance(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length - 1);
}

function verdictForStatistic(statistic: number, criticalValues: ADFCriticalValues): string {
  if (statistic <= criticalValues.fivePercent) {
    return 'Reject unit root at the 5% critical value; series is likely stationary.';
  }
  if (statistic <= criticalValues.tenPercent) {
    return 'Borderline: rejects unit root only at the 10% critical value.';
  }
  return 'Cannot reject unit root at common critical values; series may be non-stationary.';
}

function unavailable(observations: number, reason: string, lag: number | null = null): ADFResult {
  return {
    available: false,
    observations,
    lag,
    statistic: null,
    pValue: null,
    criticalValues: ASYMPTOTIC_CRITICAL_VALUES,
    verdict: 'ADF unavailable.',
    interpretation: reason,
    reason,
  };
}

export function computeADF(values: number[], requestedLag?: number): ADFResult {
  const cleanValues = values.filter(Number.isFinite);
  const observations = cleanValues.length;

  if (observations < MIN_OBSERVATIONS) {
    return unavailable(observations, `ADF needs at least ${MIN_OBSERVATIONS} finite observations.`);
  }

  if (variance(cleanValues) <= EPSILON) {
    return unavailable(observations, 'ADF is undefined for a constant transformed series.');
  }

  const initialLag = Number.isInteger(requestedLag)
    ? Math.max(0, Math.min(requestedLag as number, Math.floor((observations - 4) / 2)))
    : automaticLag(observations);
  const differences = cleanValues.slice(1).map((value, index) => value - cleanValues[index]);

  let lastFailure = '';
  for (let lag = initialLag; lag >= 0; lag -= 1) {
    const y: number[] = [];
    const x: number[][] = [];

    for (let t = lag + 1; t < observations; t += 1) {
      y.push(differences[t - 1]);
      x.push([
        cleanValues[t - 1],
        ...Array.from({ length: lag }, (_, index) => differences[t - index - 2]),
      ]);
    }

    if (y.length < x[0].length + 2) {
      lastFailure = `ADF sample is too small for lag ${lag}.`;
      continue;
    }

    // QR y no runOLS: este diseño mezcla una columna de niveles con `lag`
    // columnas de diferencias de la misma serie, y las ecuaciones normales
    // pierden la precisión al elevar al cuadrado el condicionamiento. Con un
    // IPC de 72 meses eso daba 0.08 donde el estadístico real es 4.37.
    // Ver quantbay/src/qrLeastSquares.ts.
    const fit = fitOlsQr(x, y);
    if (fit === null) {
      lastFailure = `ADF design matrix is rank deficient at lag ${lag}.`;
      continue;
    }

    {
      // tStats[0] es el intercepto; el estadístico ADF es el t del nivel
      // rezagado, que es la primera regresora.
      const statistic = fit.tStats[1];
      if (!Number.isFinite(statistic)) {
        lastFailure = 'ADF regression produced a non-finite statistic.';
        continue;
      }

      // El n que gobierna los valores críticos es el de esta regresión.
      const criticalValues = adfCriticalValues(y.length);
      const verdict = verdictForStatistic(statistic, criticalValues);
      return {
        available: true,
        observations,
        regressionObservations: y.length,
        lag,
        statistic,
        pValue: null,
        criticalValues,
        verdict,
        interpretation:
          `${verdict} Critical values (MacKinnon 2010, n = ${y.length}): ` +
          `1% ${criticalValues.onePercent.toFixed(2)}, ` +
          `5% ${criticalValues.fivePercent.toFixed(2)}, ` +
          `10% ${criticalValues.tenPercent.toFixed(2)}.`,
      };
    }
  }

  return unavailable(observations, `ADF regression failed for all lag orders from ${initialLag} to 0: ${lastFailure}`, initialLag);
}
