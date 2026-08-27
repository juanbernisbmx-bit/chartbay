import { describe, expect, it } from 'vitest';
import { isTimeSeriesAnalysisExportable, runTimeSeriesAnalysis } from '../../src/timeseries/service';

describe('runTimeSeriesAnalysis', () => {
  function datedRows(values: number[]): Array<{ date: string; close: number }> {
    return values.map((close, index) => ({
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      close,
    }));
  }

  function arOneValues(length: number): number[] {
    const values: number[] = [];
    let previous = 0;
    for (let index = 0; index < length; index += 1) {
      const shock = Math.sin(index * 1.7) + Math.cos(index * 0.4) * 0.3;
      previous = 0.55 * previous + shock;
      values.push(previous);
    }
    return values;
  }

  function randomWalkValues(length: number): number[] {
    const values: number[] = [];
    let level = 0;
    for (let index = 0; index < length; index += 1) {
      level += Math.sin(index * 0.9) + 0.2;
      values.push(level);
    }
    return values;
  }

  function seededNoiseValues(length: number): number[] {
    let seed = 123456789;
    return Array.from({ length }, () => {
      seed = (1664525 * seed + 1013904223) % 4294967296;
      return seed / 4294967296 - 0.5;
    });
  }

  function persistentArValues(length: number): number[] {
    const noise = seededNoiseValues(length);
    const values: number[] = [];
    let previous = 0;
    for (let index = 0; index < length; index += 1) {
      previous = 0.85 * previous + noise[index];
      values.push(previous);
    }
    return values;
  }

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

  it('does not consider an invalid analysis exportable', () => {
    const result = runTimeSeriesAnalysis(
      [
        { id: 1, close: 100 },
        { id: 2, close: 110 },
        { id: 3, close: 121 },
      ],
      { dateColumn: 'id', valueColumn: 'close' }
    );

    expect(result.validation.isValid).toBe(false);
    expect(result.summary.observations).toBe(0);
    expect(isTimeSeriesAnalysisExportable(result)).toBe(false);
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
  it('computes ACF from the selected transformed series and clamps requested lag', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 1 },
        { date: '2024-01-02', close: 2 },
        { date: '2024-01-03', close: 4 },
        { date: '2024-01-04', close: 8 },
        { date: '2024-01-05', close: 16 },
        { date: '2024-01-06', close: 32 },
      ],
      { dateColumn: 'date', valueColumn: 'close', transformation: 'difference', acfMaxLag: 99 }
    );

    expect(result.selectedTransformation.points.map(point => point.value)).toEqual([1, 2, 4, 8, 16]);
    expect(result.acf.observations).toBe(5);
    expect(result.acf.maxLag).toBe(2);
    expect(result.acf.rows).toHaveLength(2);
    expect(result.acf.warnings.join(' ')).toMatch(/between 1 and 2/i);
  });

  it('computes ADF for a valid stationary AR(1)-like series', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(arOneValues(140)),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 12 }
    );

    expect(result.adf.available).toBe(true);
    if (result.adf.available) {
      expect(result.adf.observations).toBe(140);
      expect(result.adf.lag).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(result.adf.statistic)).toBe(true);
      expect(result.adf.verdict).toMatch(/unit root|stationary/i);
      expect(result.adf.interpretation).toMatch(/Critical values/i);
    }
  });

  it('computes ADF for a valid random-walk-like series', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(randomWalkValues(140)),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 12 }
    );

    expect(result.adf.available).toBe(true);
    if (result.adf.available) {
      expect(result.adf.observations).toBe(140);
      expect(Number.isFinite(result.adf.statistic)).toBe(true);
      expect(result.adf.verdict).toMatch(/unit root|stationary/i);
    }
  });

  it('computes ADF for a valid differenced random-walk-like series with 140 source observations', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(randomWalkValues(140)),
      { dateColumn: 'date', valueColumn: 'close', transformation: 'difference', acfMaxLag: 12 }
    );

    expect(result.selectedTransformation.summary.observations).toBe(139);
    expect(result.adf.available).toBe(true);
    if (result.adf.available) {
      expect(result.adf.observations).toBe(139);
      expect(Number.isFinite(result.adf.statistic)).toBe(true);
      expect(result.adf.verdict).toMatch(/unit root|stationary/i);
    }
  });

  it('keeps ADF unavailable with a safe reason for constant series', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(new Array(20).fill(7)),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 3 }
    );

    expect(result.adf.available).toBe(false);
    if (!result.adf.available) {
      expect(result.adf.reason).toMatch(/constant transformed series/i);
      expect(result.adf.statistic).toBeNull();
    }
  });

  it('recommends differencing for a non-stationary random walk', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(randomWalkValues(140)),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 12 }
    );

    expect(result.recommendation).toMatch(/Educational guidance/i);
    expect(result.recommendation).toMatch(/first difference/i);
    expect(result.recommendation).not.toMatch(/forecast|profit|trading signal/i);
  });

  it('suggests AR or lag exploration for a stationary autocorrelated series', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(persistentArValues(160)),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 12 }
    );

    expect(result.recommendation).toMatch(/ADF suggests stationarity/i);
    expect(result.recommendation).toMatch(/AR or lag structure/i);
  });

  it('gives no strong warning for a stationary white-noise-like series', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(seededNoiseValues(160)),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 12 }
    );

    expect(result.recommendation).toMatch(/no strong evidence of a unit root or residual autocorrelation/i);
  });

  it('gives a data-quality recommendation when diagnostics are unavailable', () => {
    const result = runTimeSeriesAnalysis(
      datedRows(new Array(20).fill(7)),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 3 }
    );

    expect(result.recommendation).toMatch(/review data quality and sample size/i);
    expect(result.recommendation).toMatch(/constant series/i);
  });
});
