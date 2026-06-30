import { describe, expect, it } from 'vitest';
import { runOLS } from '../src/regression';
import { runRLS, type RLSConstraint } from '../src/rls';
import { loadFixture } from './fixtures/loadFixture';

// These tests validate the TypeScript engine against COMMITTED reference values
// generated once by tests/fixtures/generate_fixtures.py (statsmodels / numpy /
// scipy). Unlike statsmodelsValidation.test.ts they do NOT spawn Python, so the
// suite is reproducible on a machine without statsmodels installed.

interface OLSExpected {
  params: number[];
  fitted: number[];
  residuals: number[];
  rss: number;
  tss: number;
  ess: number;
  rSquared: number;
  adjustedRSquared: number;
  stdErrors: number[];
  tStats: number[];
  pValues: number[];
  fStat: number;
  fPValue: number;
  df: number;
}

function expectClose(actual: number, expected: number, tol = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(expected)));
}

function expectArrayClose(actual: number[], expected: number[], tol = 1e-9): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expectClose(v, expected[i], tol));
}

function checkOLS(result: ReturnType<typeof runOLS>, expected: OLSExpected): void {
  const params = [result.intercept, ...result.coefficients];
  expectArrayClose(params, expected.params);
  expectArrayClose(result.predictions, expected.fitted);
  expectArrayClose(result.residuals, expected.residuals);

  const rss = result.residuals.reduce((s, r) => s + r * r, 0);
  expectClose(rss, expected.rss);
  expectClose(result.rSquared, expected.rSquared);
  expectClose(result.adjustedRSquared, expected.adjustedRSquared);
  expect(result.df).toBe(expected.df);

  expectArrayClose(result.stdErrors, expected.stdErrors, 1e-7);
  expectArrayClose(result.tStats, expected.tStats, 1e-6);
  expectArrayClose(result.pValues, expected.pValues, 1e-6);
  expectClose(result.fStat, expected.fStat, 1e-6);
  expectClose(result.fPValue, expected.fPValue, 1e-6);
}

describe('OLS validated against committed statsmodels fixtures', () => {
  it('matches simple regression (y = b0 + b1*x)', () => {
    const fx = loadFixture<{ data: { x: number[]; y: number[] }; expected: OLSExpected }>(
      'ols_simple_statsmodels.json'
    );
    const result = runOLS({
      X: fx.data.x.map(v => [v]),
      y: fx.data.y,
      featureNames: ['x'],
      yName: 'y',
    });
    checkOLS(result, fx.expected);
  });

  it('matches multiple regression with moderately correlated regressors', () => {
    const fx = loadFixture<{ data: { X: number[][]; y: number[] }; expected: OLSExpected }>(
      'ols_multiple_statsmodels.json'
    );
    const result = runOLS({
      X: fx.data.X,
      y: fx.data.y,
      featureNames: ['x1', 'x2'],
      yName: 'y',
    });
    checkOLS(result, fx.expected);
  });

  it('matches three-regressor regression', () => {
    const fx = loadFixture<{ data: { X: number[][]; y: number[] }; expected: OLSExpected }>(
      'ols_three_statsmodels.json'
    );
    const result = runOLS({
      X: fx.data.X,
      y: fx.data.y,
      featureNames: ['x1', 'x2', 'x3'],
      yName: 'y',
    });
    checkOLS(result, fx.expected);
  });
});

describe('OLS mathematical properties (intercept model)', () => {
  const fx = loadFixture<{ data: { X: number[][]; y: number[] }; expected: OLSExpected }>(
    'ols_three_statsmodels.json'
  );
  const result = runOLS({ X: fx.data.X, y: fx.data.y, featureNames: ['x1', 'x2', 'x3'], yName: 'y' });

  it('residuals sum to ~0 when an intercept is present', () => {
    const sum = result.residuals.reduce((s, r) => s + r, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-8);
  });

  it("satisfies the normal equations X' * residuals ~= 0", () => {
    const Xd = fx.data.X.map(row => [1, ...row]);
    for (let j = 0; j < Xd[0].length; j++) {
      const dot = Xd.reduce((s, row, i) => s + row[j] * result.residuals[i], 0);
      expect(Math.abs(dot)).toBeLessThan(1e-7);
    }
  });

  it('decomposes y into fitted + residual exactly', () => {
    result.predictions.forEach((p, i) => {
      expect(Math.abs(p + result.residuals[i] - fx.data.y[i])).toBeLessThan(1e-9);
    });
  });

  it('keeps R^2 in [0,1] and adjusted R^2 <= R^2', () => {
    expect(result.rSquared).toBeGreaterThanOrEqual(0);
    expect(result.rSquared).toBeLessThanOrEqual(1);
    expect(result.adjustedRSquared).toBeLessThanOrEqual(result.rSquared + 1e-12);
  });

  it('produces RSS == TSS - ESS consistent with the fixture decomposition', () => {
    const rss = result.residuals.reduce((s, r) => s + r * r, 0);
    expectClose(rss, fx.expected.tss - fx.expected.ess, 1e-7);
  });
});

describe('RLS validated against committed reference fixtures', () => {
  interface RLSExpected {
    params: number[];
    fitted: number[];
    residuals: number[];
    rssOLS: number;
    rssRLS: number;
    rSquared: number;
    adjustedRSquared: number;
    fStatConstraint: number;
    fPValueConstraint: number;
    jConstraints: number;
    df: number;
  }
  const fx = loadFixture<{
    data: { X: number[][]; y: number[] };
    cases: Array<{ label: string; constraint: { R: number[][]; q: number[] }; expected: RLSExpected }>;
  }>('rls_restrictions_statsmodels.json');

  for (const testCase of fx.cases) {
    it(`matches restricted estimate: ${testCase.label}`, () => {
      const constraint: RLSConstraint = { ...testCase.constraint, label: testCase.label };
      const result = runRLS(
        { X: fx.data.X, y: fx.data.y, featureNames: ['x1', 'x2', 'x3'], yName: 'y' },
        constraint
      );
      const params = [result.intercept, ...result.coefficients];

      expectArrayClose(params, testCase.expected.params);
      expectArrayClose(result.predictions, testCase.expected.fitted);
      expectArrayClose(result.residuals, testCase.expected.residuals);
      expectClose(result.rssOLS!, testCase.expected.rssOLS);
      expectClose(result.rssRLS!, testCase.expected.rssRLS);
      expectClose(result.rSquared, testCase.expected.rSquared);
      expectClose(result.fStatConstraint!, testCase.expected.fStatConstraint, 1e-7);
      expectClose(result.fPValueConstraint!, testCase.expected.fPValueConstraint, 1e-7);

      // Mathematical guarantees of restricted least squares.
      expect(result.rssRLS!).toBeGreaterThanOrEqual(result.rssOLS! - 1e-9);
      expect(result.fStatConstraint!).toBeGreaterThanOrEqual(-1e-9);

      // The restriction R * beta = q must hold exactly on the restricted estimate.
      constraint.R.forEach((row, i) => {
        const lhs = row.reduce((s, c, idx) => s + c * params[idx], 0);
        expect(Math.abs(lhs - constraint.q[i])).toBeLessThan(1e-8);
      });
    });
  }
});
