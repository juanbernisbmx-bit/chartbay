import { describe, expect, it } from 'vitest';
import { computeAutocorrelation } from '../../src/timeseries/acf';

describe('computeAutocorrelation', () => {
  it('computes known autocorrelation values for a simple synthetic series', () => {
    const result = computeAutocorrelation([1, 2, 3, 4, 5], 2);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ lag: 1, outsideThreshold: false });
    expect(result.rows[0].autocorrelation).toBeCloseTo(0.4, 12);
    expect(result.rows[1].autocorrelation).toBeCloseTo(-0.1, 12);
    expect(result.threshold).toBeCloseTo(1.96 / Math.sqrt(5), 12);
  });

  it('returns a clear diagnostic for constant series', () => {
    const result = computeAutocorrelation([7, 7, 7, 7, 7], 2);

    expect(result.rows).toEqual([]);
    expect(result.threshold).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/constant/i);
  });

  it('requires enough observations', () => {
    const result = computeAutocorrelation([1, 2, 3], 1);

    expect(result.rows).toEqual([]);
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
});
