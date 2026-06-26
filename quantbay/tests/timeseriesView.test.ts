import { describe, expect, it } from 'vitest';
import {
  getTimeSeriesColumnDefaults,
  getTimeSeriesValueColumns,
} from '../src/ui/timeseriesView';
import type { ParsedCSV } from '../src/csvParser';

describe('timeseriesView helpers', () => {
  const data: ParsedCSV = {
    headers: ['date', 'close', 'label'],
    numericColumns: [],
    rows: [
      { date: '2024-01-01', close: 100, label: 'a' },
      { date: '2024-01-02', close: null, label: 'b' },
      { date: '2024-01-03', close: 110, label: 'c' },
    ],
  };

  it('keeps value columns with partial missing values selectable', () => {
    expect(getTimeSeriesValueColumns(data.rows, data.headers, 'date')).toEqual(['close']);
  });

  it('selects detected date and first numeric-like value column by default', () => {
    expect(getTimeSeriesColumnDefaults(data)).toMatchObject({
      dateColumn: 'date',
      valueColumn: 'close',
      valueColumns: ['close'],
      detectedDateColumn: 'date',
    });
  });
});
