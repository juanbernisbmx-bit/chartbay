import type { FunctionalForm } from '../functionalForms';
import type { InterpretationResult } from '../interpretation/types';
import type { DoctorCategoryKey, DoctorReport, DoctorState } from '../modelDoctor/types';

export type ModelFlow = 'cross-section' | 'time-series';
export type ModelFamily = 'linear' | 'arima';
export type ModelEngine = 'lite' | 'pro';
export type OutcomeScale = 'level' | 'log';
export type ComparisonLevel = 'direct' | 'caution' | 'incompatible';
export type ModelStandardErrorType = 'classic' | 'HC1' | 'HC3' | 'HAC';

export interface SnapshotIdentity {
  id: string;
  name?: string;
  createdAt: string;
  datasetId: string;
  datasetLabel?: string;
}

export interface ModelSpecification {
  flow: ModelFlow;
  family: ModelFamily;
  engine: ModelEngine;
  dependentVariable: string;
  outcomeScale: OutcomeScale;
  regressors: string[];
  functionalForm?: FunctionalForm;
  estimationMethod?: 'OLS' | 'RLS' | 'ARIMA';
  standardErrorType?: ModelStandardErrorType;
  hacMaxLags?: number | null;
  hasIntercept: boolean;
  restriction?: string | null;
  categoricalBaseCategories: Record<string, string>;
  timeSeriesOrder?: { p: number; d: number; q: number } | null;
  transformation?: string | null;
}

export interface ModelCoefficientResult {
  key: string;
  name: string;
  estimate: number | null;
  stdError: number | null;
  statistic: number | null;
  pValue: number | null;
  confidenceInterval: [number, number] | null;
  baseCategory?: string;
  isIntercept: boolean;
}

export interface ModelMetrics {
  nObs: number | null;
  regressorCount: number | null;
  rSquared: number | null;
  adjustedRSquared: number | null;
  fStatistic: number | null;
  fPValue: number | null;
  aic: number | null;
  bic: number | null;
}

export interface ModelSnapshot extends SnapshotIdentity {
  specification: ModelSpecification;
  coefficients: ModelCoefficientResult[];
  metrics: ModelMetrics;
  interpretation: InterpretationResult[];
  doctor: DoctorReport;
  warnings: string[];
}

export interface ComparisonWarning {
  code:
    | 'different_flow'
    | 'different_family'
    | 'different_dependent_variable'
    | 'different_outcome_scale'
    | 'different_dataset'
    | 'different_sample_size'
    | 'different_functional_form'
    | 'different_covariance'
    | 'different_dummy_base';
  message: string;
  level: 'warning' | 'block';
}

export interface ComparabilityReport {
  level: ComparisonLevel;
  warnings: ComparisonWarning[];
  compareFitMetrics: boolean;
  compareInformationCriteria: boolean;
  compareCoefficients: boolean;
  compareInference: boolean;
}

export interface CoefficientComparisonCell {
  modelId: string;
  coefficient: ModelCoefficientResult | null;
}

export interface CoefficientComparisonRow {
  key: string;
  label: string;
  presentInAll: boolean;
  changed: boolean;
  significanceChanged: boolean;
  cells: CoefficientComparisonCell[];
}

export interface ModelMetricRow {
  key: keyof ModelMetrics | 'standardErrorType' | 'functionalForm' | 'estimationMethod';
  label: string;
  values: Array<number | string | null>;
  comparable: boolean;
}

export interface DiagnosticComparisonRow {
  category: DoctorCategoryKey;
  values: Array<DoctorState | null>;
}

export interface CoefficientChange {
  coefficientKey: string;
  coefficientLabel: string;
  baselineModelId: string;
  comparisonModelId: string;
  baselineEstimate: number;
  comparisonEstimate: number;
  delta: number;
  significanceChanged: boolean;
  text: string;
}

export interface PedagogicalDifference {
  kind: 'specification' | 'fit' | 'coefficient' | 'significance' | 'inference' | 'diagnostic';
  text: string;
}

export interface ModelComparisonResult {
  models: ModelSnapshot[];
  comparability: ComparabilityReport;
  coefficientRows: CoefficientComparisonRow[];
  metricRows: ModelMetricRow[];
  diagnosticRows: DiagnosticComparisonRow[];
  coefficientChanges: CoefficientChange[];
  differences: PedagogicalDifference[];
}
