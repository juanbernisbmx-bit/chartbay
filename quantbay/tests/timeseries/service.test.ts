import { describe, expect, it } from 'vitest';
import { runTimeSeriesAnalysis } from '../../src/timeseries/service';

describe('runTimeSeriesAnalysis', () => {
  it('returns a sorted dataset, summary, validation and transformations', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-03', close: 121 },
        { date: '2024-01-01', close: 100 },
        { date: '2024-01-02', close: 110 },
      ],
      { dateColumn: 'date', valueColumn: 'close', movingAverageWindow: 2 }
    );

    expect(result.dataset.rows.map(row => row.value)).toEqual([100, 110, 121]);
    expect(result.validation.validObservationCount).toBe(3);
    expect(result.summary.observations).toBe(3);
    expect(result.summary.stdDev).toBeCloseTo(10.503968, 6);
    expect(result.summary.startDate?.toISOString().slice(0, 10)).toBe('2024-01-01');
    expect(result.summary.endDate?.toISOString().slice(0, 10)).toBe('2024-01-03');
    expect(result.summary.frequency).toBe('daily');
    expect(result.transformations.difference).toEqual([null, 10, 11]);
    expect(result.transformations.percentReturn).toEqual([null, 10, 10]);
    expect(result.transformations.base100).toEqual([100, 110, 121]);
    expect(result.transformations.movingAverage).toEqual([null, 105, 115.5]);
    expect(result.selectedTransformation.key).toBe('original');
    expect(result.selectedTransformation.points.map(point => point.value)).toEqual([100, 110, 121]);
    expect(result.interpretation.some(line => line.includes('Observations: 3'))).toBe(true);
  });

  it('surfaces warnings for duplicate and missing observations', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 100 },
        { date: '2024-01-01', close: 101 },
        { date: '2024-01-02', close: null },
      ],
      { dateColumn: 'date', valueColumn: 'close' }
    );

    expect(result.validation.duplicateDates).toEqual(['2024-01-01']);
    expect(result.validation.missingValueRows).toEqual([2]);
    expect(result.interpretation.some(line => line.includes('duplicate dates'))).toBe(true);
    expect(result.interpretation.some(line => line.includes('missing or invalid'))).toBe(true);
  });

  it('returns selected percent-return points and transformed summary', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 100 },
        { date: '2024-01-02', close: 110 },
        { date: '2024-01-03', close: 121 },
      ],
      { dateColumn: 'date', valueColumn: 'close', transformation: 'percentReturn' }
    );

    expect(result.selectedTransformation.key).toBe('percentReturn');
    expect(result.selectedTransformation.points.map(point => point.value)).toEqual([10, 10]);
    expect(result.selectedTransformation.summary.observations).toBe(2);
    expect(result.selectedTransformation.summary.mean).toBe(10);
    expect(result.selectedTransformation.warnings.join(' ')).toMatch(/reduce/i);
    expect(result.selectedTransformation.interpretation).toMatch(/relative period-to-period/i);
  });

  it('warns when log returns see non-positive values', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 100 },
        { date: '2024-01-02', close: 0 },
        { date: '2024-01-03', close: 121 },
      ],
      { dateColumn: 'date', valueColumn: 'close', transformation: 'logReturn' }
    );

    expect(result.selectedTransformation.key).toBe('logReturn');
    expect(result.selectedTransformation.points).toEqual([]);
    expect(result.selectedTransformation.warnings.join(' ')).toMatch(/positive/i);
  });

  it('warns and clamps invalid moving-average windows', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 100 },
        { date: '2024-01-02', close: 110 },
        { date: '2024-01-03', close: 121 },
      ],
      { dateColumn: 'date', valueColumn: 'close', transformation: 'movingAverage', movingAverageWindow: 9 }
    );

    expect(result.selectedTransformation.movingAverageWindow).toBe(2);
    expect(result.selectedTransformation.points.map(point => point.value)).toEqual([105, 115.5]);
    expect(result.selectedTransformation.warnings.join(' ')).toMatch(/window must be/i);
  });
});
