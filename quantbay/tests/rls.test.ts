import { describe, it, expect } from 'vitest';
import { runRLS, type RLSConstraint } from '../src/rls';
import { runOLS } from '../src/regression';

// 10 obs: y ≈ 2 + 3x (with residuals so RSS_OLS > 0)
const simpleX = [[1],[2],[3],[4],[5],[6],[7],[8],[9],[10]];
const simpleY = [5.1, 7.9, 11.2, 13.8, 16.9, 20.1, 23.1, 25.8, 28.9, 31.7];

// 10 obs: y ≈ 1 + 2x1 + 2x2 (slopes approximately equal)
const twoX = [[1,3],[2,1],[3,4],[4,2],[5,5],[6,1],[7,3],[8,2],[9,4],[10,1]];
const twoYEqualSlopes = twoX.map(([a,b]) => 1 + 2*a + 2*b + (a % 3) * 0.05);

// 10 obs: y ≈ 1 + 0.3x1 + 0.7x2 (slopes sum to 1)
const twoYSumOne = twoX.map(([a,b]) => 1 + 0.3*a + 0.7*b + (b % 2) * 0.03);

describe('runRLS – beta1 = 0', () => {
  const c: RLSConstraint = { R: [[0, 1]], q: [0], label: 'beta1 = 0' };

  it('satisfies the constraint exactly: R*beta ≈ q', () => {
    const r = runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c);
    const Rbeta = c.R[0][0] * r.intercept + c.R[0][1] * r.coefficients[0];
    expect(Rbeta).toBeCloseTo(0, 8);
  });

  it('RSS_RLS ≥ RSS_OLS', () => {
    const r = runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c);
    expect(r.rssRLS!).toBeGreaterThanOrEqual(r.rssOLS! - 1e-8);
  });

  it('F-statistic ≥ 0', () => {
    const r = runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c);
    expect(r.fStatConstraint!).toBeGreaterThanOrEqual(0);
  });

  it('p-value in [0, 1]', () => {
    const r = runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c);
    expect(r.fPValueConstraint!).toBeGreaterThanOrEqual(0);
    expect(r.fPValueConstraint!).toBeLessThanOrEqual(1);
  });

  it('method is "RLS"', () => {
    const r = runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c);
    expect(r.method).toBe('RLS');
  });

  it('F-test significant when true slope ≠ 0', () => {
    // true slope ≈ 3, so restricting to 0 should be strongly rejected
    const r = runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c);
    expect(r.fPValueConstraint!).toBeLessThan(0.01);
  });
});

describe('runRLS – beta1 = beta2', () => {
  const c: RLSConstraint = { R: [[0, 1, -1]], q: [0], label: 'beta1 = beta2' };

  it('satisfies beta1 = beta2 exactly', () => {
    const r = runRLS({ X: twoX, y: twoYEqualSlopes, featureNames: ['x1','x2'], yName: 'y' }, c);
    expect(r.coefficients[0] - r.coefficients[1]).toBeCloseTo(0, 8);
  });

  it('RSS_RLS ≥ RSS_OLS', () => {
    const r = runRLS({ X: twoX, y: twoYEqualSlopes, featureNames: ['x1','x2'], yName: 'y' }, c);
    expect(r.rssRLS!).toBeGreaterThanOrEqual(r.rssOLS! - 1e-8);
  });

  it('constraint stored in result', () => {
    const r = runRLS({ X: twoX, y: twoYEqualSlopes, featureNames: ['x1','x2'], yName: 'y' }, c);
    expect(r.rlsConstraint).toBe('beta1 = beta2');
  });
});

describe('runRLS – beta1 + beta2 = 1', () => {
  const c: RLSConstraint = { R: [[0, 1, 1]], q: [1], label: 'beta1 + beta2 = 1' };

  it('satisfies beta1 + beta2 = 1 exactly', () => {
    const r = runRLS({ X: twoX, y: twoYSumOne, featureNames: ['x1','x2'], yName: 'y' }, c);
    expect(r.coefficients[0] + r.coefficients[1]).toBeCloseTo(1, 8);
  });

  it('RSS_RLS ≥ RSS_OLS', () => {
    const r = runRLS({ X: twoX, y: twoYSumOne, featureNames: ['x1','x2'], yName: 'y' }, c);
    expect(r.rssRLS!).toBeGreaterThanOrEqual(r.rssOLS! - 1e-8);
  });

  it('constraint not rejected when data compatible (true sum ≈ 1)', () => {
    // true slopes 0.3+0.7=1, so restriction should NOT be rejected
    const r = runRLS({ X: twoX, y: twoYSumOne, featureNames: ['x1','x2'], yName: 'y' }, c);
    expect(r.fPValueConstraint!).toBeGreaterThan(0.05);
  });
});

describe('runRLS – singular / collinear matrix', () => {
  it('throws before computing RLS when design matrix is rank-deficient', () => {
    // x2 = 2*x1: perfect collinearity
    const colX = [[1,2],[2,4],[3,6],[4,8],[5,10],[6,12],[7,14],[8,16]];
    const colY = colX.map(([a]) => 1 + 3*a + 0.1);
    const c: RLSConstraint = { R: [[0,1,-1]], q: [0], label: 'beta1=beta2' };
    expect(() =>
      runRLS({ X: colX, y: colY, featureNames: ['x1','x2'], yName: 'y' }, c)
    ).toThrow();
  });

  it('throws when R has wrong column count', () => {
    // Model has 1 predictor (k=1, k+1=2), R has 3 columns — mismatch
    const c: RLSConstraint = { R: [[0, 1, -1]], q: [0], label: 'bad dim' };
    expect(() =>
      runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c)
    ).toThrow(/parámetros/);
  });
});

describe('runRLS vs runOLS consistency', () => {
  it('rssOLS in RLS result equals OLS RSS', () => {
    const c: RLSConstraint = { R: [[0, 1]], q: [0], label: 'test' };
    const r = runRLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' }, c);
    const ols = runOLS({ X: simpleX, y: simpleY, featureNames: ['x'], yName: 'y' });
    const olsRss = ols.residuals.reduce((s, v) => s + v*v, 0);
    expect(r.rssOLS!).toBeCloseTo(olsRss, 8);
  });
});
