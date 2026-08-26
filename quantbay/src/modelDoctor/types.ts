import type { FunctionalForm } from '../functionalForms';
import type { InterpretationResult } from '../interpretation/types';

export type DoctorFlow = 'cross-section' | 'time-series';
export type DoctorOverallState = 'attention' | 'review' | 'clear' | 'partial';
export type DoctorState = 'ok' | 'review' | 'problem' | 'mitigated' | 'insufficient' | 'not_applicable';
export type DoctorImpact = 'estimation' | 'inference' | 'efficiency' | 'reading';
export type DoctorEvidenceStrength = 'strong' | 'moderate' | 'borderline' | 'none';
export type DoctorConfidence = 'high' | 'medium' | 'low';

export type DoctorCategoryKey =
  | 'sample'
  | 'specification'
  | 'residuals'
  | 'inference'
  | 'heteroskedasticity'
  | 'multicollinearity'
  | 'globalSignificance'
  | 'restrictions'
  | 'stationarity'
  | 'serialCorrelation'
  | 'modelIdentification'
  | 'arimaResiduals'
  | 'forecast'
  | 'stability'
  | 'other';

export type DoctorSkipReason =
  | 'not_run'
  | 'engine_unavailable'
  | 'sample_too_small'
  | 'insufficient_df'
  | 'invalid_result'
  | 'dependency_unmet'
  | 'engine_tier'
  | 'model_shape';

export interface DoctorEvidenceLine {
  label: string;
  value: string;
}

export interface DoctorRecommendation {
  text: string;
  cost?: string;
}

export interface DoctorTheoryLink {
  id: string;
  label: string;
}

export interface DoctorFindingDetail {
  evidence: DoctorEvidenceLine[];
  conclusion: string;
  whyItMatters: string;
  whatToCheck: DoctorRecommendation[];
  whatItDoesNot: string[];
  confidenceNote: string;
  theory: DoctorTheoryLink[];
}

export interface DoctorFinding {
  category: DoctorCategoryKey;
  state: DoctorState;
  impact: DoctorImpact;
  evidence: DoctorEvidenceStrength;
  confidence: DoctorConfidence;
  headlineText: string;
  detail: DoctorFindingDetail;
  sources: string[];
  appliedRules: string[];
  insufficientReason?: DoctorSkipReason;
}

export interface ModelContext {
  mode: 'regression' | 'timeseries';
  engine: 'lite' | 'pro';
  nObs: number;
  droppedRows: number;
  paramCount: number;
  hasIntercept: boolean;
  standardErrorType: 'classic' | 'HC1' | 'HC3' | 'HAC';
  hacMaxLags: number | null;
  functionalForm: FunctionalForm;
  hasCategorical: boolean;
  droppedFeatures: string[];
  hasRestriction: boolean;
  binaryTarget: boolean;
  datasetHasDates: boolean;
  alpha: number;
  rSquared?: number | null;
  converged?: boolean;
  timeSeries?: {
    transformation: string;
    arimaOrders: { p: number; d: number; q: number } | null;
    forecastHorizon: number | null;
  };
}

export interface EngineFinding {
  id: string;
  category: string;
  severity: string;
  summary: string;
  statisticalConclusion?: string;
  practicalMeaning?: string;
  limitations: string[];
  recommendedChecks: string[];
  recommendations: DoctorRecommendation[];
  theoryConcepts: string[];
  evidence?: InterpretationResult['evidence'];
  applicability?: InterpretationResult['applicability'];
  unavailableReason?: string;
  confidenceHint?: InterpretationResult['confidenceHint'];
  impactHint?: InterpretationResult['impactHint'];
}

export interface DoctorReport {
  overallState: DoctorOverallState;
  headline: DoctorFinding | null;
  findings: DoctorFinding[];
  coverage: {
    evaluated: number;
    applicable: number;
    skipped: Array<{ category: DoctorCategoryKey; reason: DoctorSkipReason }>;
  };
  limits: string[];
  flow: DoctorFlow;
}
