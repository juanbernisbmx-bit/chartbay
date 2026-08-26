import type { FunctionalForm } from '../functionalForms';
import type { ChartBayVersion } from '../versioning/chartbayVersions';
import type { TimeSeriesTransformationKey } from '../timeseries/types';

export type ReproducibilityLanguage = 'r' | 'python' | 'stata' | 'notebook';

export interface ReproducibilityCategoricalEncoding {
  source: string;
  baseCategory: string;
  categories: string[];
  dummyNames: string[];
}

export interface ReproducibilityRestriction {
  expression: string;
  R: number[][];
  q: number[];
}

export interface ReproducibilityRegressionSpec {
  yName: string;
  xNames: string[];
  expandedXNames: string[];
  functionalForm: FunctionalForm;
  dropIncompleteRows: boolean;
  standardErrorType: 'classic' | 'HC1' | 'HC3' | 'HAC';
  hacMaxLags: number | null;
  categoricalEncodings: ReproducibilityCategoricalEncoding[];
  restriction: ReproducibilityRestriction | null;
  autoRepair: boolean;
}

export interface ReproducibilityTimeSeriesSpec {
  dateColumn: string | null;
  valueColumn: string;
  transformation: TimeSeriesTransformationKey;
  movingAverageWindow: number;
  maxLag: number;
  adfRegression: 'c' | 'ct' | 'ctt' | 'n';
  runArima: boolean;
  arimaOrder: { p: number; d: number; q: number };
  forecastSteps: number;
}

export interface ReproducibilitySpec {
  schemaVersion: 1;
  generatedAt: string;
  datasetName: string;
  mode: 'regression' | 'timeseries';
  engine: ChartBayVersion;
  regression: ReproducibilityRegressionSpec;
  timeSeries: ReproducibilityTimeSeriesSpec;
}

export interface ReproducibilityAction {
  id: number;
  timestamp: string;
  label: string;
  spec: ReproducibilitySpec;
}
