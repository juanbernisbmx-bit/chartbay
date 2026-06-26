import { describe, expect, it } from 'vitest';
import {
  logReturn,
  normalizeBase100,
  percentReturn,
  simpleDifference,
  simpleMovingAverage,
} from '../../src/timeseries/transforms';

describe('time series transforms', () => {
  it('computes simple differences', () => {
    expect(simpleDifference([10, 13, 12])).toEqual([null, 3, -1]);
  });

  it('computes percent returns', () => {
    expect(percentReturn([100, 110, 99])).toEqual([null, 10, -10]);
  });

  it('computes log returns', () => {
    const result = logReturn([100, 110]);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeCloseTo(Math.log(1.1), 10);
  });

  it('normalizes to base 100', () => {
    expect(normalizeBase100([50, 75, 100])).toEqual([100, 150, 200]);
  });

  it('computes simple moving average', () => {
    expect(simpleMovingAverage([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });

  it('returns null when percent or log return cannot be computed safely', () => {
    expect(percentReturn([0, 10])).toEqual([null, null]);
    expect(logReturn([10, 0, 12])).toEqual([null, null, null]);
  });
});
