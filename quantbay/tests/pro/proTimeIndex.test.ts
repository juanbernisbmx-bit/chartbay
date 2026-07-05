import { describe, expect, it } from 'vitest';
import type { ParsedCSV } from '../../src/csvParser';
import {
  buildFutureProTimeLabels,
  inferProTimeFrequency,
  parseProTimeValue,
  prepareProTimeSeriesValues,
} from '../../src/pro/pyodide/proTimeIndex';

function csv(rows: Record<string, unknown>[]): ParsedCSV {
  return {
    headers: Object.keys(rows[0] ?? {}),
    rows,
    numericColumns: ['value'],
  };
}

describe('proTimeIndex parsing', () => {
  it('parses YYYY-MM-DD, YYYY-MM, YYYY and ISO datetime into stable labels', () => {
    expect(parseProTimeValue('2024-01-31')?.label).toBe('2024-01-31');
    expect(parseProTimeValue('2024/02')?.label).toBe('2024-02');
    expect(parseProTimeValue('2024')?.label).toBe('2024');
    expect(parseProTimeValue('2024-03-15T12:30:00Z')?.label).toBe('2024-03-15');
  });

  it('parses day-first or month-first only when the value is not ambiguous', () => {
    expect(parseProTimeValue('31/01/2024')?.label).toBe('2024-01-31');
    expect(parseProTimeValue('01/31/2024')?.label).toBe('2024-01-31');
    expect(parseProTimeValue('01/02/2024')).toBeNull();
  });

  it('rejects invalid calendar dates', () => {
    expect(parseProTimeValue('2024-02-30')).toBeNull();
    expect(parseProTimeValue('not-a-date')).toBeNull();
  });
});

describe('proTimeIndex preparation', () => {
  it('keeps the existing no-date flow and preserves raw row order', () => {
    const result = prepareProTimeSeriesValues(csv([
      { date: '2024-02', value: 2 },
      { date: '2024-01', value: 1 },
    ]), 'value', null);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.values).toEqual([2, 1]);
      expect(result.value.timeIndex).toBeUndefined();
    }
  });

  it('sorts finite observations by selected date before modeling', () => {
    const result = prepareProTimeSeriesValues(csv([
      { date: '2024-03', value: 3 },
      { date: '2024-01', value: 1 },
      { date: '2024-02', value: 2 },
    ]), 'value', 'date');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.values).toEqual([1, 2, 3]);
      expect(result.value.timeIndex?.labels).toEqual(['2024-01', '2024-02', '2024-03']);
    }
  });

  it('blocks duplicate dates instead of grouping silently', () => {
    const result = prepareProTimeSeriesValues(csv([
      { date: '2024-01', value: 1 },
      { date: '2024-01', value: 2 },
    ]), 'value', 'date');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('duplicadas');
  });

  it('blocks invalid selected date values with a clear error', () => {
    const result = prepareProTimeSeriesValues(csv([
      { date: '2024-01', value: 1 },
      { date: 'not-a-date', value: 2 },
    ]), 'value', 'date');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('fechas validas suficientes');
  });

  it('detects monthly, yearly and daily frequencies when regular', () => {
    const monthly = ['2024-01', '2024-02', '2024-03'].map(value => parseProTimeValue(value)!);
    const yearly = ['2022', '2023', '2024'].map(value => parseProTimeValue(value)!);
    const daily = ['2024-03-15', '2024-03-16', '2024-03-17'].map(value => parseProTimeValue(value)!);
    expect(inferProTimeFrequency(monthly)).toBe('monthly');
    expect(inferProTimeFrequency(yearly)).toBe('yearly');
    expect(inferProTimeFrequency(daily)).toBe('daily');
  });

  it('marks irregular series as unknown and uses t+ labels', () => {
    const result = prepareProTimeSeriesValues(csv([
      { date: '2024-01', value: 1 },
      { date: '2024-03', value: 2 },
      { date: '2024-04', value: 3 },
    ]), 'value', 'date');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeIndex?.frequency).toBe('unknown');
      expect(result.value.timeIndex?.futureLabels.slice(0, 3)).toEqual(['t+1', 't+2', 't+3']);
    }
  });

  it('generates future monthly and yearly labels without inventing irregular dates', () => {
    expect(buildFutureProTimeLabels(parseProTimeValue('2024-03')!, 'monthly', 3))
      .toEqual(['2024-04', '2024-05', '2024-06']);
    expect(buildFutureProTimeLabels(parseProTimeValue('2023')!, 'yearly', 3))
      .toEqual(['2024', '2025', '2026']);
    expect(buildFutureProTimeLabels(parseProTimeValue('2024-03-15')!, 'daily', 3))
      .toEqual(['2024-03-16', '2024-03-17', '2024-03-18']);
  });
});
