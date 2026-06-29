export interface AutocorrelationLag {
  lag: number;
  autocorrelation: number;
  threshold: number;
  outsideThreshold: boolean;
}

export interface LjungBoxLag {
  lag: number;
  qStatistic: number;
  pValue: number;
  interpretation: string;
}

export interface AutocorrelationResult {
  observations: number;
  requestedMaxLag: number;
  maxLag: number;
  threshold: number | null;
  rows: AutocorrelationLag[];
  ljungBox: LjungBoxLag[];
  warnings: string[];
  interpretation: string;
}

const MIN_OBSERVATIONS = 4;
const DEFAULT_MAX_LAG = 12;
const HARD_MAX_LAG = 40;
const LJUNG_BOX_LAGS = [5, 10, 20];
const EPSILON = 1e-12;
const ITMAX = 100;
const FPMIN = 1e-30;

function normalizeRequestedMaxLag(requested: number | undefined): number {
  return Number.isInteger(requested) ? requested as number : DEFAULT_MAX_LAG;
}

function acfInterpretation(rows: AutocorrelationLag[]): string {
  if (rows.length === 0) {
    return 'ACF is unavailable for this transformed series.';
  }

  const strongest = rows.reduce((best, row) =>
    Math.abs(row.autocorrelation) > Math.abs(best.autocorrelation) ? row : best
  );
  if (strongest.autocorrelation > 0.1) {
    return 'Positive autocorrelation suggests persistence at that lag.';
  }
  if (strongest.autocorrelation < -0.1) {
    return 'Negative autocorrelation suggests reversal or oscillation at that lag.';
  }
  return 'Near-zero autocorrelation suggests weak linear dependence at that lag.';
}

function logGamma(value: number): number {
  const coefficients = [
    676.5203681218851,
    -1259.1392167224028,
    771.3234287776531,
    -176.6150291621406,
    12.507343278686905,
    -0.13857109526572012,
    9.984369578019572e-6,
    1.5056327351493116e-7,
  ];

  if (value < 0.5) {
    return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  }

  const shifted = value - 1;
  let sum = 0.9999999999998099;
  for (let index = 0; index < coefficients.length; index += 1) {
    sum += coefficients[index] / (shifted + index + 1);
  }

  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum);
}

function regularizedGammaP(a: number, x: number): number {
  if (x <= 0) return 0;

  let ap = a;
  let del = 1 / a;
  let sum = del;
  for (let index = 0; index < ITMAX; index += 1) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * EPSILON) {
      return Math.min(1, Math.max(0, sum * Math.exp(-x + a * Math.log(x) - logGamma(a))));
    }
  }
  return Math.min(1, Math.max(0, sum * Math.exp(-x + a * Math.log(x) - logGamma(a))));
}

function regularizedGammaQ(a: number, x: number): number {
  if (x <= 0) return 1;

  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = Math.abs(b) < FPMIN ? FPMIN : b;
  d = 1 / d;
  let h = d;

  for (let index = 1; index <= ITMAX; index += 1) {
    const an = -index * (index - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPSILON) break;
  }

  return Math.min(1, Math.max(0, Math.exp(-x + a * Math.log(x) - logGamma(a)) * h));
}

function chiSquareSurvival(value: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(value) || value < 0 || degreesOfFreedom <= 0) return NaN;
  const a = degreesOfFreedom / 2;
  const x = value / 2;
  return x < a + 1 ? 1 - regularizedGammaP(a, x) : regularizedGammaQ(a, x);
}

function ljungBoxInterpretation(pValue: number): string {
  return pValue < 0.05
    ? 'p < 0.05: evidence of autocorrelation remaining.'
    : 'p >= 0.05: no strong evidence of autocorrelation.';
}

function computeLjungBox(
  autocorrelations: AutocorrelationLag[],
  observations: number,
  lagWindows = LJUNG_BOX_LAGS
): LjungBoxLag[] {
  return lagWindows
    .filter(lag => lag > 0 && lag < observations)
    .map(lag => {
      const qStatistic = autocorrelations
        .slice(0, lag)
        .reduce((sum, row) => sum + (row.autocorrelation ** 2) / (observations - row.lag), 0)
        * observations
        * (observations + 2);
      const pValue = chiSquareSurvival(qStatistic, lag);
      return {
        lag,
        qStatistic,
        pValue,
        interpretation: ljungBoxInterpretation(pValue),
      };
    });
}

export function computeAutocorrelation(values: number[], requestedMaxLag?: number): AutocorrelationResult {
  const cleanValues = values.filter(Number.isFinite);
  const observations = cleanValues.length;
  const warnings: string[] = [];
  const rawMaxLag = normalizeRequestedMaxLag(requestedMaxLag);

  if (observations < MIN_OBSERVATIONS) {
    warnings.push('ACF needs at least 4 observations in the selected transformed series.');
    return {
      observations,
      requestedMaxLag: rawMaxLag,
      maxLag: 0,
      threshold: null,
      rows: [],
      ljungBox: [],
      warnings,
      interpretation: acfInterpretation([]),
    };
  }

  const safeMaxLag = Math.min(HARD_MAX_LAG, Math.max(1, Math.floor((observations - 1) / 2)));
  const maxLag = Math.min(Math.max(rawMaxLag, 1), safeMaxLag);
  if (rawMaxLag !== maxLag) {
    warnings.push(`ACF max lag must be between 1 and ${safeMaxLag}; using ${maxLag}.`);
  }
  if (rawMaxLag > safeMaxLag || maxLag >= observations / 2) {
    warnings.push('ACF max lag should be meaningfully smaller than the transformed sample size.');
  }

  const mean = cleanValues.reduce((sum, value) => sum + value, 0) / observations;
  const centered = cleanValues.map(value => value - mean);
  const denominator = centered.reduce((sum, value) => sum + value * value, 0);
  if (denominator <= EPSILON) {
    warnings.push('ACF is undefined for a constant transformed series.');
    return {
      observations,
      requestedMaxLag: rawMaxLag,
      maxLag,
      threshold: null,
      rows: [],
      ljungBox: [],
      warnings,
      interpretation: acfInterpretation([]),
    };
  }

  const threshold = 1.96 / Math.sqrt(observations);
  const ljungBoxMaxLag = Math.max(maxLag, ...LJUNG_BOX_LAGS.filter(lag => lag < observations));
  const autocorrelations = Array.from({ length: ljungBoxMaxLag }, (_, index) => {
    const lag = index + 1;
    let numerator = 0;
    for (let i = lag; i < observations; i += 1) {
      numerator += centered[i] * centered[i - lag];
    }
    const autocorrelation = Math.abs(numerator) <= EPSILON ? 0 : numerator / denominator;
    return {
      lag,
      autocorrelation,
      threshold,
      outsideThreshold: Math.abs(autocorrelation) > threshold,
    };
  });
  const rows = autocorrelations.slice(0, maxLag);

  return {
    observations,
    requestedMaxLag: rawMaxLag,
    maxLag,
    threshold,
    rows,
    ljungBox: computeLjungBox(autocorrelations, observations),
    warnings,
    interpretation: acfInterpretation(rows),
  };
}
