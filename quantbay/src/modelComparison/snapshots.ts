import type { CategoricalVariableInfo } from '../categoricalEncoding';
import type { FunctionalForm } from '../functionalForms';
import type { InterpretationResult } from '../interpretation/types';
import type { DoctorReport } from '../modelDoctor/types';
import type { RegressionResult } from '../regression';
import type { ModelCoefficientResult, ModelSnapshot, SnapshotIdentity } from './types';

export type SnapshotIdentityInput = Partial<SnapshotIdentity>;

interface SharedSnapshotInput {
  identity?: SnapshotIdentityInput;
  interpretations: InterpretationResult[];
  doctor: DoctorReport;
  warnings?: string[];
  categoricalInfo?: CategoricalVariableInfo[];
}

export interface LiteSnapshotInput extends SharedSnapshotInput {
  result: RegressionResult;
  functionalForm: FunctionalForm;
}


function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function unwrapLogName(name: string): string {
  const trimmed = name.trim();
  const match = /^ln\((.*)\)$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

export function coefficientKey(name: string, isIntercept = false): string {
  if (isIntercept || /^(const|intercepto|\(intercepto\))$/i.test(name.trim())) return '__intercept__';
  return unwrapLogName(name).toLocaleLowerCase();
}

function baseCategories(info: CategoricalVariableInfo[]): Record<string, string> {
  return Object.fromEntries(info.map(item => [item.originalName, item.baseCategory]));
}

function dummyBase(name: string, info: CategoricalVariableInfo[]): string | undefined {
  return info.find(item => item.createdDummies.includes(name))?.baseCategory;
}

function identity(input: SnapshotIdentityInput | undefined): SnapshotIdentity {
  return {
    id: input?.id ?? '',
    name: input?.name,
    createdAt: input?.createdAt ?? '',
    datasetId: input?.datasetId ?? '',
    datasetLabel: input?.datasetLabel,
  };
}

export function createLiteModelSnapshot(input: LiteSnapshotInput): ModelSnapshot {
  const { result, functionalForm } = input;
  const categoricalInfo = input.categoricalInfo ?? [];
  const coefficientValues = [result.intercept, ...result.coefficients];
  const names = ['Intercepto', ...result.featureNames];
  const coefficients: ModelCoefficientResult[] = names.map((name, index) => ({
    key: coefficientKey(name, index === 0),
    name,
    estimate: finite(coefficientValues[index]),
    stdError: finite(result.stdErrors[index]),
    statistic: finite(result.tStats[index]),
    pValue: finite(result.pValues[index]),
    confidenceInterval:
      result.ci95[index] && finite(result.ci95[index][0]) !== null && finite(result.ci95[index][1]) !== null
        ? [result.ci95[index][0], result.ci95[index][1]]
        : null,
    baseCategory: dummyBase(name, categoricalInfo),
    isIntercept: index === 0,
  }));

  return {
    ...identity(input.identity),
    specification: {
      flow: 'cross-section',
      family: 'linear',
      engine: 'lite',
      dependentVariable: unwrapLogName(result.yName),
      outcomeScale: functionalForm === 'log-lin' || functionalForm === 'log-log' ? 'log' : 'level',
      regressors: result.featureNames.map(unwrapLogName),
      functionalForm,
      estimationMethod: result.method ?? 'OLS',
      standardErrorType: 'classic',
      hacMaxLags: null,
      hasIntercept: true,
      restriction: result.rlsConstraint ?? null,
      categoricalBaseCategories: baseCategories(categoricalInfo),
    },
    coefficients,
    metrics: {
      nObs: finite(result.nObs),
      regressorCount: finite(result.nFeatures),
      rSquared: finite(result.rSquared),
      adjustedRSquared: finite(result.adjustedRSquared),
      fStatistic: finite(result.fStat),
      fPValue: finite(result.fPValue),
      aic: null,
      bic: null,
    },
    interpretation: input.interpretations,
    doctor: input.doctor,
    warnings: input.warnings ?? [],
  };
}
