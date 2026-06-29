export interface AutocorrelationLag {
  lag: number;
  autocorrelation: number;
  threshold: number;
  outsideThreshold: boolean;
}

export interface AutocorrelationResult {
  observations: number;
  requestedMaxLag: number;
  maxLag: number;
  threshold: number | null;
  rows: AutocorrelationLag[];
  warnings: string[];
  interpretation: string;
}

const MIN_OBSERVATIONS = 4;
const DEFAULT_MAX_LAG = 12;
const HARD_MAX_LAG = 40;
const EPSILON = 1e-12;

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
      warnings,
      interpretation: acfInterpretation([]),
    };
  }

  const threshold = 1.96 / Math.sqrt(observations);
  const rows = Array.from({ length: maxLag }, (_, index) => {
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

  return {
    observations,
    requestedMaxLag: rawMaxLag,
    maxLag,
    threshold,
    rows,
    warnings,
    interpretation: acfInterpretation(rows),
  };
}
