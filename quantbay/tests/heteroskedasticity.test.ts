import { describe, expect, it } from 'vitest';
import { breuschPaganTest } from '../src/heteroskedasticity';
import { runRegressionMode } from '../src/modes/regressionMode';
import type { ParsedCSV } from '../src/csvParser';

type Row = Record<string, unknown>;

function makeCsv(rows: Row[]): ParsedCSV {
  const headers = Object.keys(rows[0]);
  return {
    headers,
    rows,
    numericColumns: headers.filter(header => rows.every(row => typeof row[header] === 'number')),
  };
}

// Deterministic pseudo-random noise in [-1, 1] — avoids flaky tests while
// still producing values that don't correlate mechanically with the index.
function pseudoNoise(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return (x - Math.floor(x) - 0.5) * 2;
}

describe('breuschPaganTest — homoscedastic data', () => {
  const n = 60;
  const x = Array.from({ length: n }, (_, i) => i + 1);
  // Constant-magnitude noise, uncorrelated with x → residual variance should
  // not depend systematically on the regressor.
  const residuals = x.map((_, i) => pseudoNoise(i + 1) * 1.5);

  it('is available and does not detect heteroskedasticity', () => {
    const result = breuschPaganTest({
      residuals,
      designMatrix: x.map(v => [v]),
      regressorNames: ['x'],
    });

    expect(result.available).toBe(true);
    expect(result.verdict).toBe('no_evidence');
    expect(result.pValue).toBeGreaterThanOrEqual(0.05);
    expect(result.df).toBe(1);
  });
});

describe('breuschPaganTest — clear heteroskedasticity (variance grows with x)', () => {
  const n = 60;
  const x = Array.from({ length: n }, (_, i) => i + 1);
  // Noise magnitude scales with x, so e² should be strongly explained by x.
  const residuals = x.map((v, i) => pseudoNoise(i + 1) * (0.2 + 0.6 * v));

  it('is available and flags evidence of heteroskedasticity', () => {
    const result = breuschPaganTest({
      residuals,
      designMatrix: x.map(v => [v]),
      regressorNames: ['x'],
    });

    expect(result.available).toBe(true);
    expect(result.verdict).toBe('evidence');
    expect(result.pValue).toBeLessThan(0.05);
  });
});

describe('breuschPaganTest — insufficient observations', () => {
  it('returns unavailable when n <= auxiliary parameter count', () => {
    const result = breuschPaganTest({
      residuals: [0.5, -0.3],
      designMatrix: [[1], [2]],
      regressorNames: ['x'],
    });

    expect(result.available).toBe(false);
    expect(result.verdict).toBe('unavailable');
    expect(result.message).toMatch(/observaciones/i);
  });

  it('returns unavailable with an empty design matrix', () => {
    const result = breuschPaganTest({
      residuals: [0.5, -0.3, 0.1, 0.4, -0.2],
      designMatrix: [],
      regressorNames: [],
    });

    expect(result.available).toBe(false);
    expect(result.verdict).toBe('unavailable');
  });
});

describe('breuschPaganTest — auxiliary regression fails on collinearity', () => {
  it('returns unavailable when the auxiliary design matrix is singular', () => {
    const n = 20;
    const x1 = Array.from({ length: n }, (_, i) => i + 1);
    const x2 = x1.map(v => v * 2); // perfectly collinear with x1
    const residuals = x1.map((_, i) => pseudoNoise(i + 1));

    const result = breuschPaganTest({
      residuals,
      designMatrix: x1.map((v, i) => [v, x2[i]]),
      regressorNames: ['x1', 'x2'],
    });

    expect(result.available).toBe(false);
    expect(result.verdict).toBe('unavailable');
    expect(result.message).toMatch(/regresión auxiliar/i);
  });
});

describe('breuschPaganTest — non-finite and constant-variance guards', () => {
  it('rejects non-finite residuals', () => {
    const result = breuschPaganTest({
      residuals: [1, 2, Infinity, 4, 5, 6, 7, 8],
      designMatrix: [[1], [2], [3], [4], [5], [6], [7], [8]],
      regressorNames: ['x'],
    });
    expect(result.available).toBe(false);
  });

  it('rejects when e² has no variation', () => {
    const residuals = Array.from({ length: 10 }, () => 2); // constant residual → constant e²
    const result = breuschPaganTest({
      residuals,
      designMatrix: residuals.map((_, i) => [i + 1]),
      regressorNames: ['x'],
    });
    expect(result.available).toBe(false);
    expect(result.message).toMatch(/variación suficiente/i);
  });
});

// ── Integration with the regression pipeline (dummies + functional forms) ────

describe('runRegressionMode — heteroskedasticity diagnostic with categorical dummies', () => {
  it('runs Breusch-Pagan on the expanded design matrix', () => {
    const n = 30;
    const rows: Row[] = Array.from({ length: n }, (_, i) => ({
      y: 10 + 2 * (i + 1) + pseudoNoise(i + 1) * 1.5,
      x: i + 1,
      sector: i % 2 === 0 ? 'A' : 'B',
    }));

    const output = runRegressionMode(makeCsv(rows), 'y', ['x', 'sector'], undefined);

    expect(output.result.featureNames).toEqual(['x', 'sector_B']);
    expect(output.heteroskedasticity.available).toBe(true);
    expect(output.heteroskedasticity.df).toBe(output.result.featureNames.length);
  });
});

describe('runRegressionMode — heteroskedasticity diagnostic with a log functional form', () => {
  it('runs Breusch-Pagan on the already-transformed model, without reapplying logs', () => {
    const n = 30;
    const rows: Row[] = Array.from({ length: n }, (_, i) => ({
      y: Math.exp(0.5 + 0.3 * (i + 1) + pseudoNoise(i + 1) * 0.05),
      x: i + 1,
    }));

    const output = runRegressionMode(makeCsv(rows), 'y', ['x'], undefined, 'log-lin');

    expect(output.functionalForm).toBe('log-lin');
    expect(output.heteroskedasticity.available).toBe(true);
    expect(output.heteroskedasticity.df).toBe(1);
  });
});
