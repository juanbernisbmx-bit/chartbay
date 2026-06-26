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
    expect(result.summary.startDate?.toISOString().slice(0, 10)).toBe('2024-01-01');
    expect(result.summary.endDate?.toISOString().slice(0, 10)).toBe('2024-01-03');
    expect(result.summary.frequency).toBe('daily');
    expect(result.transformations.difference).toEqual([null, 10, 11]);
    expect(result.transformations.percentReturn).toEqual([null, 10, 10]);
    expect(result.transformations.base100).toEqual([100, 110, 121]);
    expect(result.transformations.movingAverage).toEqual([null, 105, 115.5]);
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
});
