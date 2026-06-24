import { describe, it, expect } from 'vitest';
import {
  runOLS,
  computeVIF,
  transpose,
  matMul,
  matInv,
  dotProduct,
  mean,
} from '../src/regression';

describe('runOLS — simple linear model y = 2x + 1', () => {
  const X = [[1], [2], [3], [4], [5]];
  const y = [3, 5, 7, 9, 11];
  const input = { X, y, featureNames: ['x'], yName: 'y' };

  it('intercept ≈ 1', () => {
    expect(runOLS(input).intercept).toBeCloseTo(1, 8);
  });

  it('coefficient ≈ 2', () => {
    expect(runOLS(input).coefficients[0]).toBeCloseTo(2, 8);
  });

  it('R² = 1 for perfect fit', () => {
    expect(runOLS(input).rSquared).toBeCloseTo(1, 8);
  });

  it('adjusted R² ≈ 1 for perfect fit', () => {
    expect(runOLS(input).adjustedRSquared).toBeCloseTo(1, 6);
  });

  it('predictions match y exactly', () => {
    const { predictions } = runOLS(input);
    predictions.forEach((p, i) => expect(p).toBeCloseTo(y[i], 6));
  });

  it('residuals sum ≈ 0 (OLS property)', () => {
    const { residuals } = runOLS(input);
    const sum = residuals.reduce((s, r) => s + r, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-8);
  });
});

describe('runOLS — noisy data', () => {
  const X = [[1], [2], [3], [4], [5]];
  const y = [2, 4, 5, 4, 5];
  const input = { X, y, featureNames: ['x'], yName: 'y' };

  it('R² is in [0, 1]', () => {
    const { rSquared } = runOLS(input);
    expect(rSquared).toBeGreaterThanOrEqual(0);
    expect(rSquared).toBeLessThanOrEqual(1);
  });

  it('adjusted R² formula matches manual calculation', () => {
    const { rSquared, adjustedRSquared } = runOLS(input);
    const n = 5, k = 1;
    const expected = 1 - (1 - rSquared) * (n - 1) / (n - k - 1);
    expect(adjustedRSquared).toBeCloseTo(expected, 10);
  });

  it('residuals sum ≈ 0', () => {
    const { residuals } = runOLS(input);
    expect(Math.abs(residuals.reduce((s, r) => s + r, 0))).toBeLessThan(1e-8);
  });
});

describe('runOLS — multiple regression y = 1 + 2·x1 + 3·x2', () => {
  const X = [[1, 1], [2, 1], [1, 2], [2, 2], [3, 3]];
  const y = [6, 8, 9, 11, 16]; // 1 + 2*x1 + 3*x2
  const input = { X, y, featureNames: ['x1', 'x2'], yName: 'y' };

  it('intercept ≈ 1',  () => expect(runOLS(input).intercept).toBeCloseTo(1, 4));
  it('β₁ ≈ 2',         () => expect(runOLS(input).coefficients[0]).toBeCloseTo(2, 4));
  it('β₂ ≈ 3',         () => expect(runOLS(input).coefficients[1]).toBeCloseTo(3, 4));
  it('nObs = 5',        () => expect(runOLS(input).nObs).toBe(5));
  it('nFeatures = 2',   () => expect(runOLS(input).nFeatures).toBe(2));

  it('equation contains y and feature names', () => {
    const eq = runOLS(input).equation;
    expect(eq).toContain('y =');
    expect(eq).toContain('x1');
    expect(eq).toContain('x2');
  });
});

describe('runOLS — error cases', () => {
  it('throws on singular matrix (collinear: x2 = 2·x1)', () => {
    const X = [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]];
    expect(() =>
      runOLS({ X, y: [1, 2, 3, 4, 5], featureNames: ['a', 'b'], yName: 'y' })
    ).toThrow();
  });

  it('throws when n < k + 2', () => {
    expect(() =>
      runOLS({ X: [[1]], y: [1], featureNames: ['x'], yName: 'y' })
    ).toThrow();
  });
});

describe('Matrix utilities', () => {
  it('transpose 3×2 → 2×3', () => {
    expect(transpose([[1, 2], [3, 4], [5, 6]])).toEqual([[1, 3, 5], [2, 4, 6]]);
  });

  it('matMul 2×2 × 2×2', () => {
    expect(matMul([[1, 2], [3, 4]], [[5, 6], [7, 8]])).toEqual([[19, 22], [43, 50]]);
  });

  it('matInv of identity is identity', () => {
    const inv = matInv([[1, 0], [0, 1]]);
    expect(inv[0][0]).toBeCloseTo(1); expect(inv[0][1]).toBeCloseTo(0);
    expect(inv[1][0]).toBeCloseTo(0); expect(inv[1][1]).toBeCloseTo(1);
  });

  it('A × A⁻¹ ≈ I', () => {
    const A = [[2, 1], [5, 3]];
    const I = matMul(A, matInv(A));
    expect(I[0][0]).toBeCloseTo(1); expect(I[0][1]).toBeCloseTo(0);
    expect(I[1][0]).toBeCloseTo(0); expect(I[1][1]).toBeCloseTo(1);
  });

  it('dotProduct([1,2,3],[4,5,6]) = 32', () =>
    expect(dotProduct([1, 2, 3], [4, 5, 6])).toBe(32));

  it('mean([1,2,3,4,5]) = 3', () => expect(mean([1, 2, 3, 4, 5])).toBe(3));
});

// ── Phase 2 — statistical inference ──────────────────────────────────────────

describe('runOLS Phase 2 — std errors, t-stats, p-values', () => {
  const X = [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]];
  const y = [11.1, 21.3, 30.8, 41.2, 51.0, 60.9, 71.1, 81.3, 90.7, 100.9];
  const result = runOLS({ X, y, featureNames: ['x'], yName: 'y' });

  it('stdErrors are non-negative', () => {
    result.stdErrors.forEach(se => expect(se).toBeGreaterThanOrEqual(0));
  });

  it('|tStat| = |coef / stdError|', () => {
    result.tStats.forEach((t, i) => {
      if (result.stdErrors[i] > 1e-10 && isFinite(t)) {
        const beta = i === 0 ? result.intercept : result.coefficients[i - 1];
        expect(Math.abs(t)).toBeCloseTo(Math.abs(beta / result.stdErrors[i]), 5);
      }
    });
  });

  it('pValues are in [0, 1]', () => {
    result.pValues.forEach(p => {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    });
  });

  it('coefficient for x is highly significant (p < 0.001)', () => {
    expect(result.pValues[1]).toBeLessThan(0.001);
  });

  it('df = n − k − 1', () => {
    expect(result.df).toBe(8); // n=10, k=1
  });

  it('sigma2 > 0 for noisy data', () => {
    expect(result.sigma2).toBeGreaterThan(0);
  });

  it('sigma2 = ssRes / df', () => {
    const ssRes = result.residuals.reduce((s, r) => s + r ** 2, 0);
    expect(result.sigma2).toBeCloseTo(ssRes / result.df, 8);
  });
});

// ── Phase 2 — VIF ────────────────────────────────────────────────────────────

describe('computeVIF', () => {
  it('single predictor returns [1]', () => {
    const X = [[1], [2], [3], [4], [5]];
    expect(computeVIF(X)).toEqual([1]);
  });

  it('uncorrelated predictors → VIF < 5', () => {
    const X = [[1, 3], [2, 1], [3, 4], [4, 2], [5, 5], [6, 3], [7, 1]];
    computeVIF(X).forEach(v => expect(v).toBeLessThan(5));
  });

  it('near-collinear predictors → high VIF', () => {
    const X = Array.from({ length: 8 }, (_, i) => [i + 1, i + 1.005]);
    computeVIF(X).forEach(v => expect(v).toBeGreaterThan(50));
  });
});
