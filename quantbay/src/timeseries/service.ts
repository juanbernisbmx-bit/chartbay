import type {
  TimeSeriesAnalysisResult,
  TimeSeriesFrequency,
  TimeSeriesSummary,
  TimeSeriesTransformationKey,
  TimeSeriesTransformedPoint,
  TimeSeriesTransformedSeries,
  TimeSeriesTransformations,
} from './types';
import { computeAutocorrelation } from './acf';
import { computeADF } from './adf';
import { buildTimeSeriesRecommendation } from './recommendation';
import { logReturn, normalizeBase100, percentReturn, simpleDifference, simpleMovingAverage } from './transforms';
import { interpretTimeSeriesSummary } from './interpretation';
import { validateTimeSeriesDataset } from './validation';

export interface RunTimeSeriesAnalysisOptions {
  dateColumn?: string;
  valueColumn: string;
  movingAverageWindow?: number;
  transformation?: TimeSeriesTransformationKey;
  acfMaxLag?: number;
}

export function isTimeSeriesAnalysisExportable(result: TimeSeriesAnalysisResult): boolean {
  return result.validation.isValid;
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
      stdDev: null,
      frequency: 'unknown',
    };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;

  return {
    observations: values.length,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    mean,
    stdDev: Math.sqrt(variance),
    frequency: inferFrequency(dates),
  };
}

function transformationLabel(key: TimeSeriesTransformationKey): string {
  switch (key) {
    case 'difference':
      return 'Simple difference';
    case 'percentReturn':
      return 'Percent return';
    case 'logReturn':
      return 'Log return';
    case 'base100':
      return 'Base-100 index';
    case 'movingAverage':
      return 'Simple moving average';
    default:
      return 'Original series';
  }
}

function transformationInterpretation(key: TimeSeriesTransformationKey): string {
  switch (key) {
    case 'difference':
      return 'Difference shows absolute period-to-period change.';
    case 'percentReturn':
      return 'Percent return shows relative period-to-period change.';
    case 'logReturn':
      return 'Log return is a continuously compounded return and is valid only for positive values.';
    case 'base100':
      return 'Base-100 normalizes the series as an index from the first valid observation.';
    case 'movingAverage':
      return 'Simple moving average is a smoothed trend indicator.';
    default:
      return 'Original series shows the selected values without transformation.';
  }
}

function normalizeMovingAverageWindow(requested: number | undefined, observations: number): { window: number; warnings: string[] } {
  const warnings: string[] = [];
  const rawWindow = Number.isInteger(requested) ? requested as number : 3;
  if (observations < 3) {
    warnings.push('Moving average requires at least 3 observations.');
    return { window: Math.max(1, observations), warnings };
  }

  const maxWindow = observations - 1;
  const window = Math.min(Math.max(rawWindow, 2), maxWindow);
  if (rawWindow !== window) {
    warnings.push(`Moving average window must be between 2 and ${maxWindow}; using ${window}.`);
  }
  return { window, warnings };
}

function pointsFromValues(dates: Date[], values: Array<number | null>): TimeSeriesTransformedPoint[] {
  return values.flatMap((value, index) =>
    value === null || !Number.isFinite(value) ? [] : [{ date: dates[index], value }]
  );
}

function buildSelectedTransformation(
  dates: Date[],
  values: number[],
  transformations: TimeSeriesTransformations,
  frequency: TimeSeriesFrequency,
  key: TimeSeriesTransformationKey,
  movingAverageWindow: number | undefined
): TimeSeriesTransformedSeries {
  const warnings: string[] = [];
  let valuesForKey: Array<number | null>;
  let effectiveWindow: number | undefined;

  switch (key) {
    case 'difference':
      valuesForKey = transformations.difference;
      warnings.push('Differencing reduces the transformed series by one observation.');
      break;
    case 'percentReturn':
      valuesForKey = transformations.percentReturn;
      warnings.push('Returns reduce the transformed series by one observation.');
      break;
    case 'logReturn':
      valuesForKey = transformations.logReturn;
      warnings.push('Log returns reduce the transformed series by one observation.');
      if (values.some(value => value <= 0)) {
        warnings.push('Log return requires all values to be positive; non-positive periods are omitted.');
      }
      break;
    case 'base100':
      valuesForKey = transformations.base100;
      break;
    case 'movingAverage': {
      const normalized = normalizeMovingAverageWindow(movingAverageWindow, values.length);
      warnings.push(...normalized.warnings);
      effectiveWindow = normalized.window;
      valuesForKey = simpleMovingAverage(values, normalized.window);
      warnings.push(`Moving average uses a ${normalized.window}-period window and has fewer initial observations.`);
      break;
    }
    default:
      valuesForKey = values;
  }

  if (frequency === 'irregular') {
    warnings.push('Irregular frequency may affect interpretation of period-to-period transformations.');
  }

  const points = pointsFromValues(dates, valuesForKey);
  return {
    key,
    label: transformationLabel(key),
    points,
    summary: summarize(points.map(point => point.value), points.map(point => point.date)),
    warnings,
    interpretation: transformationInterpretation(key),
    movingAverageWindow: effectiveWindow,
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
  const movingAverageWindow = normalizeMovingAverageWindow(options.movingAverageWindow, values.length).window;
  const transformations = {
    difference: simpleDifference(values),
    percentReturn: percentReturn(values),
    logReturn: logReturn(values),
    base100: normalizeBase100(values),
    movingAverage: simpleMovingAverage(values, movingAverageWindow),
  };
  const transformation = options.transformation ?? 'original';

  const selectedTransformation = buildSelectedTransformation(
    dates,
    values,
    transformations,
    summary.frequency,
    transformation,
    options.movingAverageWindow
  );
  const acf = computeAutocorrelation(
    selectedTransformation.points.map(point => point.value),
    options.acfMaxLag
  );
  const adf = computeADF(selectedTransformation.points.map(point => point.value));
  if (selectedTransformation.summary.frequency === 'irregular') {
    acf.warnings.push('Irregular frequency should be interpreted carefully when reading ACF lags.');
  }

  const result: TimeSeriesAnalysisResult = {
    dataset,
    validation,
    summary,
    transformations,
    selectedTransformation,
    acf,
    adf,
    recommendation: '',
    interpretation: interpretTimeSeriesSummary(summary, validation),
  };
  result.recommendation = buildTimeSeriesRecommendation(result);
  return result;
}
