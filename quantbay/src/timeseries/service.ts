import type { TimeSeriesAnalysisResult, TimeSeriesFrequency, TimeSeriesSummary } from './types';
import { logReturn, normalizeBase100, percentReturn, simpleDifference, simpleMovingAverage } from './transforms';
import { interpretTimeSeriesSummary } from './interpretation';
import { validateTimeSeriesDataset } from './validation';

export interface RunTimeSeriesAnalysisOptions {
  dateColumn?: string;
  valueColumn: string;
  movingAverageWindow?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function inferFrequency(dates: Date[]): TimeSeriesFrequency {
  if (dates.length < 3) return 'unknown';

  const gaps = dates
    .slice(1)
    .map((date, index) => Math.round((date.getTime() - dates[index].getTime()) / DAY_MS))
    .filter(gap => gap > 0);
  if (gaps.length === 0) return 'unknown';

  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const maxDeviation = Math.max(...gaps.map(gap => Math.abs(gap - median)));

  if (maxDeviation > Math.max(2, median * 0.35)) return 'irregular';
  if (median <= 1) return 'daily';
  if (median >= 6 && median <= 8) return 'weekly';
  if (median >= 28 && median <= 31) return 'monthly';
  if (median >= 89 && median <= 92) return 'quarterly';
  if (median >= 365 && median <= 366) return 'yearly';
  return 'irregular';
}

function summarize(values: number[], dates: Date[]): TimeSeriesSummary {
  if (values.length === 0) {
    return {
      observations: 0,
      startDate: null,
      endDate: null,
      min: null,
      max: null,
      mean: null,
      frequency: 'unknown',
    };
  }

  return {
    observations: values.length,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    frequency: inferFrequency(dates),
  };
}

export function runTimeSeriesAnalysis(
  rows: Record<string, unknown>[],
  options: RunTimeSeriesAnalysisOptions
): TimeSeriesAnalysisResult {
  const { dataset, validation } = validateTimeSeriesDataset(rows, options.valueColumn, options.dateColumn);
  const values = dataset.rows.map(row => row.value);
  const dates = dataset.rows.map(row => row.date);
  const summary = summarize(values, dates);
  const transformations = {
    difference: simpleDifference(values),
    percentReturn: percentReturn(values),
    logReturn: logReturn(values),
    base100: normalizeBase100(values),
    movingAverage: simpleMovingAverage(values, options.movingAverageWindow ?? 3),
  };

  return {
    dataset,
    validation,
    summary,
    transformations,
    interpretation: interpretTimeSeriesSummary(summary, validation),
  };
}
