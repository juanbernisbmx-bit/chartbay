import type { FunctionalForm } from '../functionalForms';

export type InterpretationSeverity = 'positive' | 'warning' | 'neutral' | 'critical';
export type InterpretationApplicability = 'applies' | 'not_applicable' | 'unavailable';

export interface InterpretationEvidence {
  testName?: string;
  statistic?: number | null;
  pValue?: number | null;
  df?: number | null;
  threshold?: number | null;
  sampleSize?: number | null;
  scope?: 'series' | 'model_residuals';
}
export type InterpretationCategory =
  | 'coefficient'
  | 'model_fit'
  | 'inference'
  | 'assumption'
  | 'multicollinearity'
  | 'residuals'
  | 'time_series'
  | 'forecast';

export interface InterpretationStep {
  label: string;
  rationale?: string;
}

/** Salida portable: no contiene HTML ni referencias al DOM. */
export interface InterpretationResult {
  id: string;
  severity: InterpretationSeverity;
  category: InterpretationCategory;
  title: string;
  summary: string;
  statisticalConclusion?: string;
  practicalMeaning?: string;
  limitations: string[];
  nextSteps: InterpretationStep[];
  theoryConcepts: string[];
  affectedAssumption?: string;
  recommendedChecks: string[];
  /** Campos estructurados consumidos por Model Doctor; nunca se derivan del texto visible. */
  diagnosticCategory?: string;
  evidence?: InterpretationEvidence;
  applicability?: InterpretationApplicability;
  unavailableReason?: string;
  confidenceHint?: 'high' | 'medium' | 'low';
  impactHint?: 'estimation' | 'inference' | 'efficiency' | 'reading';
}

export interface InterpretationContext {
  alpha?: number;
  functionalForm?: FunctionalForm;
  yName?: string;
  nObs?: number;
  hasIntercept?: boolean;
}

export type CoefficientKind = 'continuous' | 'dummy' | 'interaction' | 'intercept';

export interface CoefficientInput extends InterpretationContext {
  name: string;
  estimate: number | null | undefined;
  stdError?: number | null;
  statistic?: number | null;
  pValue?: number | null;
  confidenceInterval?: [number, number] | null;
  kind?: CoefficientKind;
  baseCategory?: string;
}

export interface ModelFitInput extends InterpretationContext {
  rSquared?: number | null;
  adjustedRSquared?: number | null;
  fStatistic?: number | null;
  fPValue?: number | null;
  regressorCount?: number;
}

export interface HypothesisTestInput extends InterpretationContext {
  title?: string;
  statistic?: number | null;
  pValue?: number | null;
  restrictions?: number | null;
  hypothesis?: string;
}

export interface BreuschPaganInput extends InterpretationContext {
  statistic?: number | null;
  pValue?: number | null;
}

export interface VIFInput {
  variable: string;
  value: number | null | undefined;
}

export interface ADFInput extends InterpretationContext {
  statistic?: number | null;
  pValue?: number | null;
  criticalValues?: { onePercent?: number; fivePercent?: number; tenPercent?: number };
  specification?: string;
}

export interface LjungBoxInput extends InterpretationContext {
  lag: number;
  statistic?: number | null;
  pValue?: number | null;
  residuals?: boolean;
}

export interface AcfPacfInput {
  significantAcfLags: number[];
  significantPacfLags: number[];
  observations?: number;
}

export interface ArimaInput {
  p: number;
  d: number;
  q: number;
  converged?: boolean;
  aic?: number | null;
  bic?: number | null;
}

export interface ForecastInput {
  steps: number;
  confidenceLevel?: number | null;
  hasIntervals: boolean;
  converged?: boolean;
}

export type InterpretableResult =
  | { type: 'coefficient'; result: CoefficientInput }
  | { type: 'model_fit'; result: ModelFitInput }
  | { type: 'breusch_pagan'; result: BreuschPaganInput }
  | { type: 'vif'; result: VIFInput }
  | { type: 'adf'; result: ADFInput }
  | { type: 'ljung_box'; result: LjungBoxInput }
  | { type: 'acf_pacf'; result: AcfPacfInput }
  | { type: 'arima'; result: ArimaInput }
  | { type: 'forecast'; result: ForecastInput };
