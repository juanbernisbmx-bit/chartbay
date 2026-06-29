export type TimeSeriesFrequency =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | 'irregular'
  | 'unknown';

export type TimeSeriesValidationIssueType =
  | 'missing_date_column'
  | 'invalid_date'
  | 'duplicate_date'
  | 'missing_value'
  | 'empty_series'
  | 'insufficient_observations';

export interface TimeSeriesRow {
  date: Date;
  value: number;
  rawDate: unknown;
  rawValue: unknown;
  original: Record<string, unknown>;
  index: number;
}

export interface TimeSeriesDataset {
  dateColumn: string | null;
  valueColumn: string;
  rows: TimeSeriesRow[];
}

export interface TimeSeriesValidationIssue {
  type: TimeSeriesValidationIssueType;
  message: string;
  rowIndex?: number;
  column?: string;
  dateKey?: string;
}

export interface TimeSeriesValidationResult {
  isValid: boolean;
  dateColumn: string | null;
  valueColumn: string;
  issues: TimeSeriesValidationIssue[];
  duplicateDates: string[];
  missingValueRows: number[];
  invalidDateRows: number[];
  validObservationCount: number;
}

export interface TimeSeriesSummary {
  observations: number;
  startDate: Date | null;
  endDate: Date | null;
  min: number | null;
  max: number | null;
  mean: number | null;
  stdDev: number | null;
  frequency: TimeSeriesFrequency;
}

export type TimeSeriesTransformationKey =
  | 'original'
  | 'difference'
  | 'percentReturn'
  | 'logReturn'
  | 'base100'
  | 'movingAverage';

export interface TimeSeriesTransformations {
  difference: Array<number | null>;
  percentReturn: Array<number | null>;
  logReturn: Array<number | null>;
  base100: Array<number | null>;
  movingAverage: Array<number | null>;
}

export interface TimeSeriesTransformedPoint {
  date: Date;
  value: number;
}

export interface TimeSeriesACFLag {
  lag: number;
  autocorrelation: number;
  threshold: number;
  outsideThreshold: boolean;
}

export interface TimeSeriesLjungBoxLag {
  lag: number;
  qStatistic: number;
  pValue: number;
  interpretation: string;
}

export interface TimeSeriesPACFLag {
  lag: number;
  partialAutocorrelation: number;
  threshold: number;
  outsideThreshold: boolean;
}

export interface TimeSeriesACFDiagnostics {
  observations: number;
  requestedMaxLag: number;
  maxLag: number;
  threshold: number | null;
  rows: TimeSeriesACFLag[];
  pacf: TimeSeriesPACFLag[];
  ljungBox: TimeSeriesLjungBoxLag[];
  warnings: string[];
  interpretation: string;
  pacfInterpretation: string;
}
export interface TimeSeriesTransformedSeries {
  key: TimeSeriesTransformationKey;
  label: string;
  points: TimeSeriesTransformedPoint[];
  summary: TimeSeriesSummary;
  warnings: string[];
  interpretation: string;
  movingAverageWindow?: number;
}

export interface TimeSeriesAnalysisResult {
  dataset: TimeSeriesDataset;
  validation: TimeSeriesValidationResult;
  summary: TimeSeriesSummary;
  transformations: TimeSeriesTransformations;
  selectedTransformation: TimeSeriesTransformedSeries;
  acf: TimeSeriesACFDiagnostics;
  interpretation: string[];
}
