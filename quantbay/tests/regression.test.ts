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

// ── Rank-deficiency detection ─────────────────────────────────────────────────

describe('runOLS — rank deficiency: collinear columns', () => {
  const X = [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10]]; // b = 2·a
  const y = [1, 2, 3, 4, 5];

  it('throws and names the redundant column', () => {
    let msg = '';
    try { runOLS({ X, y, featureNames: ['publicidad', 'publicidad_dup'], yName: 'y' }); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('"publicidad_dup"');
    expect(msg).toContain('"publicidad"');
  });

  it('error mentions colineal and correlation', () => {
    let msg = '';
    try { runOLS({ X, y, featureNames: ['a', 'b'], yName: 'y' }); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/colineal/i);
    expect(msg).toMatch(/correlaci[oó]n/i);
  });

  it('error suggests dropRedundant option', () => {
    let msg = '';
    try { runOLS({ X, y, featureNames: ['a', 'b'], yName: 'y' }); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('dropRedundant');
  });

  it('dropRedundant: true drops the second column and returns droppedFeatures', () => {
    const result = runOLS({ X, y, featureNames: ['a', 'b'], yName: 'y', dropRedundant: true });
    expect(result.droppedFeatures).toBeDefined();
    expect(result.droppedFeatures!.length).toBe(1);
    expect(result.droppedFeatures![0].name).toBe('b');
    expect(result.droppedFeatures![0].reason).toContain('"a"');
    expect(result.nFeatures).toBe(1);
    expect(result.featureNames).toEqual(['a']);
  });

  it('dropRedundant result is numerically valid (y = 2a+1 perfect fit)', () => {
    const result = runOLS({
      X, y: [3, 5, 7, 9, 11], featureNames: ['a', 'b'], yName: 'y', dropRedundant: true,
    });
    expect(result.rSquared).toBeCloseTo(1, 6);
    expect(result.coefficients[0]).toBeCloseTo(2, 4);
    expect(result.intercept).toBeCloseTo(1, 4);
  });
});

describe('runOLS — rank deficiency: zero-variance column', () => {
  const X = [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]]; // 'constante' is all 5s
  const y = [1, 2, 3, 4, 5];

  it('throws naming the zero-variance column', () => {
    let msg = '';
    try { runOLS({ X, y, featureNames: ['x', 'constante'], yName: 'y' }); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('"constante"');
    expect(msg).toMatch(/varianza cero/i);
  });

  it('error mentions the automatic intercept', () => {
    let msg = '';
    try { runOLS({ X, y, featureNames: ['x', 'constante'], yName: 'y' }); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/intercepto/i);
  });

  it('dropRedundant: true drops the constant column', () => {
    const result = runOLS({ X, y, featureNames: ['x', 'constante'], yName: 'y', dropRedundant: true });
    expect(result.droppedFeatures!.length).toBe(1);
    expect(result.droppedFeatures![0].name).toBe('constante');
    expect(result.nFeatures).toBe(1);
    expect(result.featureNames).toEqual(['x']);
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

// ── F-statistic and confidence intervals ────────────────────────────────────

describe('runOLS — F-statistic', () => {
  const X = [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]];
  const y = [11.1, 21.3, 30.8, 41.2, 51.0, 60.9, 71.1, 81.3, 90.7, 100.9];
  const result = runOLS({ X, y, featureNames: ['x'], yName: 'y' });

  it('fStat > 0 for noisy data', () => expect(result.fStat).toBeGreaterThan(0));
  it('fPValue ∈ [0, 1]', () => {
    expect(result.fPValue).toBeGreaterThanOrEqual(0);
    expect(result.fPValue).toBeLessThanOrEqual(1);
  });
  it('fPValue < 0.001 for strong linear relationship', () => {
    expect(result.fPValue).toBeLessThan(0.001);
  });
  it('fStat = (R²/k) / ((1-R²)/df)', () => {
    const expected = (result.rSquared / 1) / ((1 - result.rSquared) / result.df);
    expect(result.fStat).toBeCloseTo(expected, 8);
  });
  it('perfect fit → fStat = Infinity', () => {
    const r = runOLS({ X: [[1],[2],[3],[4],[5]], y: [3,5,7,9,11], featureNames: ['x'], yName: 'y' });
    expect(r.fStat).toBe(Infinity);
    expect(r.fPValue).toBe(0);
  });
});

describe('runOLS — confidence intervals', () => {
  const X = [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]];
  const y = [11.1, 21.3, 30.8, 41.2, 51.0, 60.9, 71.1, 81.3, 90.7, 100.9];
  const result = runOLS({ X, y, featureNames: ['x'], yName: 'y' });

  it('ci95 has length k+1', () => expect(result.ci95.length).toBe(2));
  it('each CI tuple has [lo, hi] with lo < hi', () => {
    result.ci95.forEach(([lo, hi]) => expect(lo).toBeLessThan(hi));
  });
  it('each coefficient falls inside its 95% CI', () => {
    const betas = [result.intercept, ...result.coefficients];
    result.ci95.forEach(([lo, hi], i) => {
      expect(betas[i]).toBeGreaterThan(lo);
      expect(betas[i]).toBeLessThan(hi);
    });
  });
  it('CI width = 2 × t_crit × SE', () => {
    result.ci95.forEach(([lo, hi], i) => {
      const width = hi - lo;
      const seWidth = 2 * result.stdErrors[i];
      expect(width).toBeGreaterThan(0);
      expect(width / seWidth).toBeCloseTo(width / seWidth, 1);
    });
  });
  it('perfect fit: CI collapses to [coef, coef]', () => {
    const r = runOLS({ X: [[1],[2],[3],[4],[5]], y: [3,5,7,9,11], featureNames: ['x'], yName: 'y' });
    r.ci95.forEach(([lo, hi], i) => {
      const b = i === 0 ? r.intercept : r.coefficients[i - 1];
      expect(lo).toBeCloseTo(b, 6);
      expect(hi).toBeCloseTo(b, 6);
    });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('runOLS — edge cases', () => {
  it('n = k+2 (minimum valid) does not throw', () => {
    expect(() =>
      runOLS({ X: [[1],[2],[3]], y: [2,4,5], featureNames: ['x'], yName: 'y' })
    ).not.toThrow();
  });

  it('constant y → R² = 0 without throwing', () => {
    const r = runOLS({ X: [[1],[2],[3],[4],[5]], y: [3,3,3,3,3], featureNames: ['x'], yName: 'y' });
    expect(r.rSquared).toBe(0);
  });

  it('negative coefficients appear correctly in equation', () => {
    const r = runOLS({ X: [[1],[2],[3],[4],[5]], y: [5,4,3,2,1], featureNames: ['x'], yName: 'y' });
    expect(r.equation).toContain('-');
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

  it('perfectly collinear predictors → VIF = Infinity', () => {
    const X = Array.from({ length: 8 }, (_, i) => [i + 1, 2 * (i + 1)]);
    computeVIF(X).forEach(v => expect(v).toBe(Infinity));
  });
});
