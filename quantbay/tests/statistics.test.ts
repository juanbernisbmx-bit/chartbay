import { describe, it, expect } from 'vitest';
import { betaInc, tDistPValue, fDistPValue, tQuantile, pearsonMatrix } from '../src/statistics';

describe('betaInc', () => {
  it('returns 0 at x=0', () => expect(betaInc(0, 1, 1)).toBe(0));
  it('returns 1 at x=1', () => expect(betaInc(1, 1, 1)).toBe(1));

  it('betaInc(0.5, 1, 1) = 0.5  (uniform CDF)', () => {
    expect(betaInc(0.5, 1, 1)).toBeCloseTo(0.5, 5);
  });

  it('symmetry: betaInc(x, a, b) + betaInc(1-x, b, a) = 1', () => {
    expect(betaInc(0.3, 2, 5) + betaInc(0.7, 5, 2)).toBeCloseTo(1, 5);
  });

  it('betaInc(0.25, 0.5, 0.5) = 1/3  (arcsine distribution)', () => {
    // I(0.25; 0.5, 0.5) = (2/π) * arcsin(√0.25) = (2/π) * (π/6) = 1/3
    expect(betaInc(0.25, 0.5, 0.5)).toBeCloseTo(1 / 3, 5);
  });
});

describe('tDistPValue', () => {
  it('t=0 gives p=1', () => {
    expect(tDistPValue(0, 10)).toBeCloseTo(1, 3);
  });

  it('t=2.228, df=10 → p≈0.05  (known two-tailed critical value)', () => {
    expect(tDistPValue(2.228, 10)).toBeCloseTo(0.05, 2);
  });

  it('t=12.706, df=1 → p≈0.05  (Cauchy distribution)', () => {
    expect(tDistPValue(12.706, 1)).toBeCloseTo(0.05, 2);
  });

  it('t=2.042, df=30 → p≈0.05', () => {
    expect(tDistPValue(2.042, 30)).toBeCloseTo(0.05, 2);
  });

  it('large |t| gives p near 0', () => {
    expect(tDistPValue(10, 5)).toBeLessThan(0.001);
  });

  it('symmetric: tDistPValue(t, df) = tDistPValue(-t, df)', () => {
    expect(tDistPValue(-2.5, 15)).toBeCloseTo(tDistPValue(2.5, 15), 8);
  });

  it('non-finite t → 0', () => {
    expect(tDistPValue(Infinity, 10)).toBe(0);
    expect(tDistPValue(-Infinity, 10)).toBe(0);
  });

  it('df=0 → 0', () => {
    expect(tDistPValue(1, 0)).toBe(0);
  });
});

describe('fDistPValue', () => {
  it('f=0 gives p=1', () => expect(fDistPValue(0, 1, 10)).toBeCloseTo(1, 3));
  it('f=Infinity gives p=0', () => expect(fDistPValue(Infinity, 1, 10)).toBe(0));
  it('f=4.96, df1=1, df2=10 → p ≈ 0.05', () => {
    expect(fDistPValue(4.96, 1, 10)).toBeCloseTo(0.05, 2);
  });
  it('f=4.17, df1=1, df2=30 → p ≈ 0.05', () => {
    expect(fDistPValue(4.17, 1, 30)).toBeCloseTo(0.05, 2);
  });
  it('large f gives p near 0', () => expect(fDistPValue(100, 5, 20)).toBeLessThan(0.001));
  it('invalid df1 → 1', () => expect(fDistPValue(3, 0, 10)).toBe(1));
  it('invalid df2 → 1', () => expect(fDistPValue(3, 1, 0)).toBe(1));
  it('negative f → 1', () => expect(fDistPValue(-1, 1, 10)).toBe(1));
});

describe('tQuantile', () => {
  it('tQuantile(0.05, 10) ≈ 2.228  (two-tailed 95% critical value)', () => {
    expect(tQuantile(0.05, 10)).toBeCloseTo(2.228, 2);
  });
  it('tQuantile(0.05, 30) ≈ 2.042', () => {
    expect(tQuantile(0.05, 30)).toBeCloseTo(2.042, 2);
  });
  it('tQuantile(0.05, 1) ≈ 12.706  (Cauchy)', () => {
    expect(tQuantile(0.05, 1)).toBeCloseTo(12.706, 1);
  });
  it('round-trips: tDistPValue(tQuantile(0.05, df), df) ≈ 0.05', () => {
    const t = tQuantile(0.05, 20);
    expect(tDistPValue(t, 20)).toBeCloseTo(0.05, 4);
  });
  it('df=0 → Infinity', () => expect(tQuantile(0.05, 0)).toBe(Infinity));
});

describe('pearsonMatrix', () => {
  it('diagonal entries are always 1', () => {
    const corr = pearsonMatrix([[1, 2, 3, 4, 5], [5, 3, 1, 4, 2]]);
    expect(corr[0][0]).toBeCloseTo(1, 8);
    expect(corr[1][1]).toBeCloseTo(1, 8);
  });

  it('perfect positive linear relationship → r = 1', () => {
    const a = [1, 2, 3, 4, 5];
    const b = a.map(x => 3 * x + 7);
    expect(pearsonMatrix([a, b])[0][1]).toBeCloseTo(1, 6);
  });

  it('perfect negative linear relationship → r = -1', () => {
    const a = [1, 2, 3, 4, 5];
    const b = a.map(x => -2 * x + 10);
    expect(pearsonMatrix([a, b])[0][1]).toBeCloseTo(-1, 6);
  });

  it('matrix is symmetric', () => {
    const cols = [[1, 2, 3, 4, 5], [5, 3, 1, 4, 2], [2, 4, 6, 1, 3]];
    const corr = pearsonMatrix(cols);
    expect(corr[0][1]).toBeCloseTo(corr[1][0], 10);
    expect(corr[0][2]).toBeCloseTo(corr[2][0], 10);
    expect(corr[1][2]).toBeCloseTo(corr[2][1], 10);
  });

  it('constant column → off-diagonal 0, diagonal 1', () => {
    const a = [1, 1, 1, 1, 1];
    const b = [1, 2, 3, 4, 5];
    const corr = pearsonMatrix([a, b]);
    expect(corr[0][0]).toBe(1);
    expect(corr[0][1]).toBe(0);
  });

  it('empty input returns empty matrix', () => {
    expect(pearsonMatrix([])).toEqual([]);
  });

  it('3-column matrix has shape 3×3', () => {
    const corr = pearsonMatrix([[1, 2, 3], [4, 5, 6], [7, 8, 9]]);
    expect(corr.length).toBe(3);
    expect(corr[0].length).toBe(3);
  });
});
