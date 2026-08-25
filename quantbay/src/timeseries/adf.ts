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
const CRITICAL_VALUES: ADFCriticalValues = {
  onePercent: -3.43,
  fivePercent: -2.86,
  tenPercent: -2.57,
};

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
    criticalValues: CRITICAL_VALUES,
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

      const verdict = verdictForStatistic(statistic, CRITICAL_VALUES);
      return {
        available: true,
        observations,
        lag,
        statistic,
        pValue: null,
        criticalValues: CRITICAL_VALUES,
        verdict,
        interpretation: `${verdict} Critical values: 1% ${CRITICAL_VALUES.onePercent}, 5% ${CRITICAL_VALUES.fivePercent}, 10% ${CRITICAL_VALUES.tenPercent}.`,
      };
    }
  }

  return unavailable(observations, `ADF regression failed for all lag orders from ${initialLag} to 0: ${lastFailure}`, initialLag);
}
