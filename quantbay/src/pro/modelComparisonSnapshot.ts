import type { CategoricalVariableInfo } from '../categoricalEncoding';
import type { InterpretationResult } from '../interpretation/types';
import type { DoctorReport } from '../modelDoctor/types';
import { coefficientKey, unwrapLogName, type SnapshotIdentityInput } from '../modelComparison/snapshots';
import type { ModelCoefficientResult, ModelSnapshot, SnapshotIdentity } from '../modelComparison/types';
import type { PyodideOlsResult } from './pyodide/proResultTypes';

export interface ProSnapshotInput {
  identity?: SnapshotIdentityInput;
  result: PyodideOlsResult;
  interpretations: InterpretationResult[];
  doctor: DoctorReport;
  warnings?: string[];
  categoricalInfo?: CategoricalVariableInfo[];
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function identity(input: SnapshotIdentityInput | undefined): SnapshotIdentity {
  return { id: input?.id ?? '', name: input?.name, createdAt: input?.createdAt ?? '', datasetId: input?.datasetId ?? '', datasetLabel: input?.datasetLabel };
}

function baseCategories(info: CategoricalVariableInfo[]): Record<string, string> {
  return Object.fromEntries(info.map(item => [item.originalName, item.baseCategory]));
}

function dummyBase(name: string, info: CategoricalVariableInfo[]): string | undefined {
  return info.find(item => item.createdDummies.includes(name))?.baseCategory;
}

export function createProModelSnapshot(input: ProSnapshotInput): ModelSnapshot {
  const { result } = input;
  if (!result.ok || !result.coefficients || !result.yName) throw new Error('No se puede guardar un resultado Pro incompleto.');
  const categoricalInfo = input.categoricalInfo ?? result.categoricalInfo ?? [];
  const functionalForm = result.functionalForm ?? 'lin-lin';
  const coefficients = result.coefficients.map((coefficient, index): ModelCoefficientResult => {
    const isIntercept = index === 0 && /^(const|intercept|intercepto|\(intercepto\))$/i.test(coefficient.name);
    return {
      key: coefficientKey(coefficient.name, isIntercept), name: isIntercept ? 'Intercepto' : coefficient.name,
      estimate: finite(coefficient.estimate), stdError: finite(coefficient.stdError), statistic: finite(coefficient.tStat),
      pValue: finite(coefficient.pValue), confidenceInterval: coefficient.confidenceInterval ?? null,
      baseCategory: dummyBase(coefficient.name, categoricalInfo), isIntercept,
    };
  });
  return {
    ...identity(input.identity),
    specification: {
      flow: 'cross-section', family: 'linear', engine: 'pro', dependentVariable: unwrapLogName(result.yName),
      outcomeScale: functionalForm === 'log-lin' || functionalForm === 'log-log' ? 'log' : 'level',
      regressors: (result.xNames ?? coefficients.filter(item => !item.isIntercept).map(item => item.name)).map(unwrapLogName),
      functionalForm, estimationMethod: 'OLS', standardErrorType: result.standardErrorType ?? 'classic',
      hacMaxLags: result.hacMaxLags ?? null, hasIntercept: coefficients.some(item => item.isIntercept),
      restriction: result.rlsTest?.label ?? null, categoricalBaseCategories: baseCategories(categoricalInfo),
    },
    coefficients,
    metrics: {
      nObs: finite(result.nobs), regressorCount: result.xNames?.length ?? Math.max(0, coefficients.length - 1),
      rSquared: finite(result.rSquared), adjustedRSquared: finite(result.rSquaredAdj), fStatistic: finite(result.fStat),
      fPValue: finite(result.fPValue), aic: finite(result.aic), bic: finite(result.bic),
    },
    interpretation: input.interpretations, doctor: input.doctor,
    warnings: [...result.warnings, ...(input.warnings ?? [])],
  };
}
