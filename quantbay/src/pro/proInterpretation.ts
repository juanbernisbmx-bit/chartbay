import type { PyodideOlsResult } from './pyodide/proResultTypes';
import type { InterpretationResult } from '../interpretation/types';
import {
  interpretBreuschPagan,
  interpretCoefficient,
  interpretModelFit,
  interpretResiduals,
  interpretWald,
} from '../interpretation/engine';

/** Pro-only adapter. Keeping it under /pro preserves Lite engine isolation. */
export function interpretProResult(result: PyodideOlsResult, alpha = 0.05): InterpretationResult[] {
  if (!result.ok) return [];
  const dummyToBase = new Map<string, string>();
  for (const info of result.categoricalInfo ?? []) {
    for (const name of info.createdDummies) dummyToBase.set(name, info.baseCategory);
  }
  const outputs: InterpretationResult[] = [interpretModelFit({
    rSquared: result.rSquared,
    adjustedRSquared: result.rSquaredAdj,
    fStatistic: result.fStat,
    fPValue: result.fPValue,
    regressorCount: Math.max(0, (result.coefficients?.length ?? 1) - 1),
    nObs: result.nobs,
    alpha,
  })];
  for (const coefficient of result.coefficients ?? []) {
    const isIntercept = /^(intercept|const)$/i.test(coefficient.name);
    const interaction = /[*:×]/.test(coefficient.name);
    outputs.push(interpretCoefficient({
      name: coefficient.name,
      estimate: coefficient.estimate,
      stdError: coefficient.stdError,
      statistic: coefficient.tStat,
      pValue: coefficient.pValue,
      kind: isIntercept ? 'intercept' : interaction ? 'interaction' : dummyToBase.has(coefficient.name) ? 'dummy' : 'continuous',
      baseCategory: dummyToBase.get(coefficient.name),
      functionalForm: result.functionalForm,
      yName: result.yName,
      nObs: result.nobs,
      alpha,
    }));
  }
  if (result.residuals) outputs.push(interpretResiduals(result.residuals));
  if (result.rlsTest) outputs.push(interpretWald({
    title: 'Restricción lineal (Wald/F)', statistic: result.rlsTest.fStat,
    pValue: result.rlsTest.fPValue, restrictions: result.rlsTest.dfNum,
    hypothesis: result.rlsTest.label, alpha, nObs: result.nobs,
  }));
  if (result.breuschPagan) outputs.push(interpretBreuschPagan({
    statistic: result.breuschPagan.fStatistic,
    pValue: result.breuschPagan.fPValue,
    alpha, nObs: result.nobs,
  }));
  return outputs;
}
