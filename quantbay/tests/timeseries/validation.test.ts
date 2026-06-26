import { describe, expect, it } from 'vitest';
import { detectDateColumn, validateTimeSeriesDataset } from '../../src/timeseries/validation';

describe('time series validation', () => {
  it('detects a candidate date column', () => {
    const rows = [
      { date: '2024-01-01', value: 10 },
      { date: '2024-01-02', value: 11 },
    ];

    expect(detectDateColumn(rows)).toBe('date');
  });

  it('validates parseable and invalid dates', () => {
    const { validation } = validateTimeSeriesDataset(
      [
        { date: '2024-01-01', value: 10 },
        { date: 'not-a-date', value: 11 },
      ],
      'value',
      'date'
    );

    expect(validation.invalidDateRows).toEqual([1]);
    expect(validation.issues.some(issue => issue.type === 'invalid_date')).toBe(true);
  });

  it('detects duplicate dates', () => {
    const { validation } = validateTimeSeriesDataset(
      [
        { date: '2024-01-01', value: 10 },
        { date: '2024-01-01', value: 11 },
        { date: '2024-01-02', value: 12 },
      ],
      'value',
      'date'
    );

    expect(validation.duplicateDates).toEqual(['2024-01-01']);
    expect(validation.issues.some(issue => issue.type === 'duplicate_date')).toBe(true);
  });

  it('sorts rows by date', () => {
    const { dataset } = validateTimeSeriesDataset(
      [
        { date: '2024-01-03', value: 30 },
        { date: '2024-01-01', value: 10 },
        { date: '2024-01-02', value: 20 },
      ],
      'value',
      'date'
    );

    expect(dataset.rows.map(row => row.value)).toEqual([10, 20, 30]);
  });

  it('detects missing values', () => {
    const { validation } = validateTimeSeriesDataset(
      [
        { date: '2024-01-01', value: 10 },
        { date: '2024-01-02', value: null },
      ],
      'value',
      'date'
    );

    expect(validation.missingValueRows).toEqual([1]);
    expect(validation.issues.some(issue => issue.type === 'missing_value')).toBe(true);
  });

  it('detects empty series and fewer than 3 valid observations', () => {
    const { validation } = validateTimeSeriesDataset([], 'value');

    expect(validation.issues.some(issue => issue.type === 'empty_series')).toBe(true);
    expect(validation.issues.some(issue => issue.type === 'insufficient_observations')).toBe(true);
  });
});
