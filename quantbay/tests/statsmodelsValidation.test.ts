/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runOLS } from '../src/regression';
import { runRLS, type RLSConstraint } from '../src/rls';
import { validateAnalysisInput } from '../src/services/analysisService';

interface StatsmodelsCase {
  params: number[];
  fitted: number[];
  residuals: number[];
  rss: number;
  rSquared: number;
  adjustedRSquared: number;
  stdErrors: number[];
  tStats: number[];
  pValues: number[];
  fStat: number | null;
}

interface Dataset {
  X: number[][];
  y: number[];
}

let maxObservedDifference = 0;
let maxScaledDifference = 0;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function centeredUniform(rng: () => number, scale = 1): number {
  return (rng() - 0.5) * 2 * scale;
}

function generateDataset(seed: number, n: number, k: number): Dataset {
  const rng = mulberry32(seed);
  const beta = Array.from({ length: k + 1 }, (_, index) =>
    index === 0 ? centeredUniform(rng, 2) : centeredUniform(rng, 3)
  );
  const X = Array.from({ length: n }, (_, rowIndex) =>
    Array.from({ length: k }, (_, colIndex) =>
      centeredUniform(rng, 4) + 0.07 * rowIndex + 0.13 * colIndex
    )
  );
  const y = X.map(row =>
    beta[0] +
    row.reduce((sum, value, index) => sum + value * beta[index + 1], 0) +
    centeredUniform(rng, 0.25)
  );
  return { X, y };
}

function statsmodelsOLSBatch(datasets: Dataset[]): StatsmodelsCase[] {
  const script = String.raw`
import json
import math
import sys

import statsmodels.api as sm

def clean(value):
    value = float(value)
    if math.isnan(value):
        return None
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value

payload = json.loads(sys.stdin.read())
output = []
for dataset in payload:
    model = sm.OLS(dataset["y"], sm.add_constant(dataset["X"], has_constant="add"))
    result = model.fit()
    output.append({
        "params": [clean(v) for v in result.params],
        "fitted": [clean(v) for v in result.fittedvalues],
        "residuals": [clean(v) for v in result.resid],
        "rss": clean(result.ssr),
        "rSquared": clean(result.rsquared),
        "adjustedRSquared": clean(result.rsquared_adj),
        "stdErrors": [clean(v) for v in result.bse],
        "tStats": [clean(v) for v in result.tvalues],
        "pValues": [clean(v) for v in result.pvalues],
        "fStat": clean(result.fvalue),
    })
print(json.dumps(output))
`;
  const raw = execFileSync('python', ['-c', script], {
    input: JSON.stringify(datasets),
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
  return JSON.parse(raw, (_key, value) => {
    if (value === 'Infinity') return Infinity;
    if (value === '-Infinity') return -Infinity;
    return value;
  }) as StatsmodelsCase[];
}

function observeDiff(actual: number, expected: number): void {
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return;
  const difference = Math.abs(actual - expected);
  maxObservedDifference = Math.max(maxObservedDifference, difference);
  maxScaledDifference = Math.max(maxScaledDifference, difference / Math.max(1, Math.abs(expected)));
}

function expectClose(actual: number, expected: number, tolerance = 1e-10): void {
  observeDiff(actual, expected);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(1, Math.abs(expected)));
}

function expectArrayClose(actual: number[], expected: number[], tolerance = 1e-10): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expectClose(value, expected[index], tolerance));
}

describe('runOLS validated against Python statsmodels', () => {
  const datasets = Array.from({ length: 40 }, (_, index) => {
    const k = 1 + (index % 4);
    const n = k + 8 + (index % 9);
    return generateDataset(10_000 + index, n, k);
  });

  it('matches coefficients, fitted values, residuals, RSS, R2, inference, and F-statistic', () => {
    const statsmodelsResults = statsmodelsOLSBatch(datasets);
    for (const [datasetIndex, dataset] of datasets.entries()) {
      const names = dataset.X[0].map((_, index) => `x${index + 1}`);
      const chartBay = runOLS({ ...dataset, featureNames: names, yName: 'y' });
      const statsmodels = statsmodelsResults[datasetIndex];
      const rss = chartBay.residuals.reduce((sum, value) => sum + value * value, 0);

      expectArrayClose([chartBay.intercept, ...chartBay.coefficients], statsmodels.params);
      expectArrayClose(chartBay.predictions, statsmodels.fitted);
      expectArrayClose(chartBay.residuals, statsmodels.residuals);
      expectClose(rss, statsmodels.rss);
      expectClose(chartBay.rSquared, statsmodels.rSquared);
      expectClose(chartBay.adjustedRSquared, statsmodels.adjustedRSquared);
      expectArrayClose(chartBay.stdErrors, statsmodels.stdErrors);
      expectArrayClose(chartBay.tStats, statsmodels.tStats);
      expectArrayClose(chartBay.pValues, statsmodels.pValues);
      expectClose(chartBay.fStat, statsmodels.fStat ?? NaN);
    }
  });

  it('records the maximum finite numerical difference observed by the validation sweep', () => {
    expect(maxObservedDifference).toBeGreaterThanOrEqual(0);
    expect(maxScaledDifference).toBeLessThanOrEqual(1e-10);
  });
});

describe('econometric edge-case validation', () => {
  it('rejects perfect multicollinearity and duplicated columns with a diagnostic', () => {
    const X = [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]];
    expect(() => runOLS({ X, y: [1, 2, 3, 4, 5, 6], featureNames: ['x1', 'x2'], yName: 'y' }))
      .toThrow(/colineal|rango|redundante/i);
  });

  it('rejects constant predictors as rank deficient against the intercept', () => {
    const X = [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5], [6, 5]];
    expect(() => runOLS({ X, y: [2, 4, 6, 8, 10, 12], featureNames: ['x', 'constant'], yName: 'y' }))
      .toThrow(/constante|varianza cero|intercepto/i);
  });

  it('rejects one observation and very small samples without degrees of freedom', () => {
    expect(() => runOLS({ X: [[1]], y: [1], featureNames: ['x'], yName: 'y' })).toThrow(/observaciones/);
    expect(() => runOLS({ X: [[1], [2]], y: [1, 2], featureNames: ['x'], yName: 'y' })).toThrow(/observaciones/);
  });

  it('handles nearly singular but full-rank matrices without non-finite outputs', () => {
    const X = Array.from({ length: 20 }, (_, index) => {
      const x = index + 1;
      return [x, x + (index % 2 === 0 ? 1e-4 : -1e-4)];
    });
    const y = X.map(([x1, x2], index) => 1 + 0.4 * x1 + 0.6 * x2 + (index % 3) * 1e-3);
    const result = runOLS({ X, y, featureNames: ['x1', 'x2'], yName: 'y' });
    expect([result.intercept, ...result.coefficients, ...result.stdErrors, ...result.tStats, ...result.pValues].every(Number.isFinite))
      .toBe(true);
  });

  it('handles very large and very small finite values when the design is well-conditioned after scaling', () => {
    const large = generateDataset(42_001, 120, 3);
    large.X = large.X.map(row => row.map(value => value * 1e6));
    large.y = large.y.map(value => value * 1e6);
    const small = generateDataset(42_002, 120, 3);
    small.X = small.X.map(row => row.map(value => value * 1e-6));
    small.y = small.y.map(value => value * 1e-6);

    for (const dataset of [large, small]) {
      const result = runOLS({ ...dataset, featureNames: ['x1', 'x2', 'x3'], yName: 'y' });
      expect([result.intercept, ...result.coefficients, result.rSquared, result.adjustedRSquared, result.fStat].every(Number.isFinite))
        .toBe(true);
    }
  });

  it('flags missing and infinite values before estimation in the analysis validation layer', () => {
    const missingIssues = validateAnalysisInput({
      rows: [
        { y: 1, x: 1 },
        { y: 2, x: '' },
        { y: 3, x: 3 },
      ],
      numericColumns: ['y', 'x'],
      headers: ['y', 'x'],
    }, 'y', ['x']);
    const infiniteIssues = validateAnalysisInput({
      rows: [
        { y: 1, x: 1 },
        { y: 2, x: Number.POSITIVE_INFINITY },
        { y: 3, x: 3 },
      ],
      numericColumns: ['y', 'x'],
      headers: ['y', 'x'],
    }, 'y', ['x']);

    expect(missingIssues.some(issue => issue.type === 'missing_values')).toBe(true);
    expect(infiniteIssues.some(issue => issue.type === 'invalid_numeric')).toBe(true);
  });

  it('supports large datasets with stable finite diagnostics', () => {
    const dataset = generateDataset(51_000, 5_000, 4);
    const result = runOLS({ ...dataset, featureNames: ['x1', 'x2', 'x3', 'x4'], yName: 'y' });
    expect(result.nObs).toBe(5_000);
    expect(result.df).toBe(4_995);
    expect([result.rSquared, result.adjustedRSquared, result.sigma2, result.fStat, result.fPValue].every(Number.isFinite))
      .toBe(true);
  });
});

describe('runRLS mathematical validation', () => {
  it('satisfies multiple simultaneous linear constraints and computes the restricted F test', () => {
    const dataset = generateDataset(91_000, 36, 3);
    const constraint: RLSConstraint = {
      R: [
        [0, 1, -1, 0],
        [0, 0, 1, 1],
      ],
      q: [0.25, 1.1],
      label: 'beta1 - beta2 = 0.25; beta2 + beta3 = 1.1',
    };
    const result = runRLS({ ...dataset, featureNames: ['x1', 'x2', 'x3'], yName: 'y' }, constraint);
    const beta = [result.intercept, ...result.coefficients];
    const rssOLS = runOLS({ ...dataset, featureNames: ['x1', 'x2', 'x3'], yName: 'y' })
      .residuals.reduce((sum, value) => sum + value * value, 0);
    const expectedF = ((result.rssRLS! - rssOLS) / 2) / (rssOLS / result.df);

    expectClose(beta[1] - beta[2], 0.25);
    expectClose(beta[2] + beta[3], 1.1);
    expectClose(result.fStatConstraint!, expectedF);
    expect(result.fPValueConstraint).toBeGreaterThanOrEqual(0);
    expect(result.fPValueConstraint).toBeLessThanOrEqual(1);
  });

  it('reports infinite overall F-statistic for a perfect restricted fit', () => {
    const X = [[1], [2], [3], [4], [5], [6]];
    const y = [3, 5, 7, 9, 11, 13];
    const result = runRLS(
      { X, y, featureNames: ['x'], yName: 'y' },
      { R: [[0, 1]], q: [2], label: 'beta1 = 2' }
    );
    expect(result.rSquared).toBeCloseTo(1, 12);
    expect(result.fStat).toBe(Infinity);
    expect(result.fPValue).toBe(0);
  });
});
