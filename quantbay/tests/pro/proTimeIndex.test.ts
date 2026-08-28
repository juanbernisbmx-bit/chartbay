import { describe, expect, it } from 'vitest';
import { PREVIEW_ROWS, type ParsedCSV } from '../../src/csvParser';
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

function columnarTimeSeries(rowCount: number): ParsedCSV {
  const start = Date.UTC(2024, 0, 1) / 86_400_000;
  const dates = Float64Array.from({ length: rowCount }, (_, i) => start + i);
  const values = Float64Array.from({ length: rowCount }, (_, i) => i + 1);
  const mask = new Uint8Array(rowCount).fill(1);
  return {
    headers: ['date', 'value'],
    rows: Array.from({ length: PREVIEW_ROWS }, (_, i) => ({
      date: new Date((start + i) * 86_400_000).toISOString().slice(0, 10),
      value: i + 1,
    })),
    numericColumns: ['date', 'value'],
    rowCount,
    columns: {
      numeric: new Map([
        ['date', { values: dates, mask }],
        ['value', { values, mask }],
      ]),
      categorical: new Map(),
      text: new Map(),
      dateColumns: new Set(['date']),
      rowCount,
    },
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

  it('models every columnar row instead of the 50-row preview', () => {
    const result = prepareProTimeSeriesValues(columnarTimeSeries(240), 'value', 'date');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.values).toHaveLength(240);
      expect(result.value.values[result.value.values.length - 1]).toBe(240);
      expect(result.value.timeIndex?.labels).toHaveLength(240);
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
