import { describe, expect, it } from 'vitest';
import { computeAutocorrelation } from '../../src/timeseries/acf';

describe('computeAutocorrelation', () => {
  it('computes known autocorrelation values for a simple synthetic series', () => {
    const result = computeAutocorrelation([1, 2, 3, 4, 5], 2);

    expect(result.rows).toHaveLength(2);
    expect(result.pacf).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ lag: 1, outsideThreshold: false });
    expect(result.rows[0].autocorrelation).toBeCloseTo(0.4, 12);
    expect(result.rows[1].autocorrelation).toBeCloseTo(-0.1, 12);
    expect(result.threshold).toBeCloseTo(1.96 / Math.sqrt(5), 12);
  });

  it('returns a clear diagnostic for constant series', () => {
    const result = computeAutocorrelation([7, 7, 7, 7, 7], 2);

    expect(result.rows).toEqual([]);
    expect(result.pacf).toEqual([]);
    expect(result.threshold).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/constant/i);
  });

  it('requires enough observations', () => {
    const result = computeAutocorrelation([1, 2, 3], 1);

    expect(result.rows).toEqual([]);
    expect(result.pacf).toEqual([]);
    expect(result.maxLag).toBe(0);
    expect(result.warnings.join(' ')).toMatch(/at least 4 observations/i);
  });

  it('clamps max lag to safe bounds', () => {
    const high = computeAutocorrelation([1, 2, 4, 8, 16, 32, 64, 128, 256, 512], 99);
    const low = computeAutocorrelation([1, 2, 4, 8, 16], 0);

    expect(high.maxLag).toBe(4);
    expect(high.rows).toHaveLength(4);
    expect(high.warnings.join(' ')).toMatch(/between 1 and 4/i);
    expect(low.maxLag).toBe(1);
    expect(low.warnings.join(' ')).toMatch(/between 1 and 2/i);
  });

  it('flags lags outside the approximate significance threshold', () => {
    const result = computeAutocorrelation([1, -1, 1, -1, 1, -1], 1);

    expect(result.rows[0].autocorrelation).toBeCloseTo(-5 / 6, 12);
    expect(result.rows[0].threshold).toBeCloseTo(1.96 / Math.sqrt(6), 12);
    expect(result.rows[0].outsideThreshold).toBe(true);
  });

  it('reports a notable lag-1 PACF for an AR(1)-like series', () => {
    const shocks = [
      0.15, -0.05, 0.08, -0.02, 0.04, -0.03, 0.05, -0.01, 0.03, -0.04,
      0.02, 0.01, -0.03, 0.04, -0.02, 0.03, -0.01, 0.02, -0.04, 0.05,
      -0.02, 0.01, 0.03, -0.03, 0.04, -0.01, 0.02, -0.02, 0.05, -0.04,
      0.03, -0.01, 0.02, -0.03, 0.04, -0.02, 0.01, 0.03, -0.01, 0.02,
    ];
    const series = shocks.reduce<number[]>((values, shock, index) => {
      values.push(index === 0 ? shock : 0.78 * values[index - 1] + shock);
      return values;
    }, []);
    const result = computeAutocorrelation(series, 5);

    expect(result.pacf[0]).toMatchObject({ lag: 1, outsideThreshold: true });
    expect(result.pacf[0].partialAutocorrelation).toBeGreaterThan(result.pacf[0].threshold);
    expect(result.pacfInterpretation).toMatch(/autoregressive structure/i);
    expect(result.pacfInterpretation).toMatch(/AR order/i);
  });

  it('keeps PACF lags inside the threshold for an approximately white-noise series', () => {
    const series = [
      0.040856, 0.464865, -0.460898, 0.352626, 0.926171, 0.411301, 1.562064, -0.885076,
      0.067390, -0.705217, -0.783588, -0.183858, 0.221283, 0.418978, 0.508136, 2.233711,
      0.862561, -1.594528, 0.204377, -0.623036, -0.515748, 1.306226, -0.222938, -1.951281,
      0.310587, -0.291474, -1.174422, -0.921085, -0.625277, -0.023402, -0.426705, 0.071470,
      1.836230, -0.800253, -0.807443, -0.249173, 1.095553, -0.706217, 1.434284, -1.308112,
    ];
    const result = computeAutocorrelation(series, 5);

    expect(result.pacf).toHaveLength(5);
    expect(result.pacf.every(row => !row.outsideThreshold)).toBe(true);
    expect(result.pacfInterpretation).toMatch(/avoid overclaiming/i);
  });

  it('handles small samples safely for PACF', () => {
    const tooSmall = computeAutocorrelation([1, 2, 3], 3);
    const validMinimum = computeAutocorrelation([1, 2, 3, 4], 3);

    expect(tooSmall.pacf).toEqual([]);
    expect(validMinimum.pacf).toHaveLength(1);
    expect(validMinimum.pacf[0].lag).toBe(1);
  });

  it('does not report PACF rows for constant or invalid-only series', () => {
    const constant = computeAutocorrelation([2, 2, Number.NaN, Number.POSITIVE_INFINITY, 2, 2], 3);
    const invalidOnly = computeAutocorrelation([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY], 3);

    expect(constant.pacf).toEqual([]);
    expect(constant.warnings.join(' ')).toMatch(/constant/i);
    expect(invalidOnly.pacf).toEqual([]);
    expect(invalidOnly.warnings.join(' ')).toMatch(/at least 4 observations/i);
  });

  it('reports Ljung-Box evidence for a known autocorrelated series', () => {
    const series = Array.from({ length: 40 }, (_, index) => index % 2 === 0 ? 1 : -1);
    const result = computeAutocorrelation(series, 5);

    expect(result.ljungBox.map(row => row.lag)).toEqual([5, 10, 20]);
    expect(result.ljungBox[0].qStatistic).toBeGreaterThan(40);
    expect(result.ljungBox[0].pValue).toBeLessThan(0.05);
    expect(result.ljungBox[0].interpretation).toMatch(/evidence of autocorrelation remaining/i);
  });

  it('reports no strong Ljung-Box evidence for an approximately white-noise series', () => {
    const series = [
      0.040856, 0.464865, -0.460898, 0.352626, 0.926171, 0.411301, 1.562064, -0.885076,
      0.067390, -0.705217, -0.783588, -0.183858, 0.221283, 0.418978, 0.508136, 2.233711,
      0.862561, -1.594528, 0.204377, -0.623036, -0.515748, 1.306226, -0.222938, -1.951281,
      0.310587, -0.291474, -1.174422, -0.921085, -0.625277, -0.023402, -0.426705, 0.071470,
      1.836230, -0.800253, -0.807443, -0.249173, 1.095553, -0.706217, 1.434284, -1.308112,
    ];
    const result = computeAutocorrelation(series, 5);

    expect(result.ljungBox.map(row => row.lag)).toEqual([5, 10, 20]);
    expect(result.ljungBox[0].pValue).toBeGreaterThanOrEqual(0.05);
    expect(result.ljungBox[0].interpretation).toMatch(/no strong evidence/i);
  });

  it('skips Ljung-Box lag windows that are not valid for small samples', () => {
    const result = computeAutocorrelation([1, 2, 3, 4], 1);

    expect(result.rows).toHaveLength(1);
    expect(result.ljungBox).toEqual([]);
  });

  it('does not report Ljung-Box rows for constant series', () => {
    const result = computeAutocorrelation([2, 2, 2, 2, 2, 2, 2], 3);

    expect(result.rows).toEqual([]);
    expect(result.ljungBox).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/constant/i);
  });
});
