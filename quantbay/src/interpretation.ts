// Compatibility facade. The statistical rules live in interpretation/engine;
// this file only adapts existing Lite results and preserves the old text API.
import type { FunctionalForm } from './functionalForms';
import type { RegressionResult } from './regression';
import type { InterpretationResult } from './interpretation/types';
import { interpretCoefficient, interpretModelFit, interpretResiduals, interpretWald } from './interpretation/engine';

export * from './interpretation/engine';
export * from './interpretation/types';

export interface RegressionInterpretationOptions {
  alpha?: number;
  functionalForm?: FunctionalForm;
  dummyNames?: string[];
  baseCategories?: Record<string, string>;
}

export function interpretRegressionResult(
  result: RegressionResult,
  options: RegressionInterpretationOptions = {}
): InterpretationResult[] {
  const dummyNames = new Set(options.dummyNames ?? []);
  const outputs: InterpretationResult[] = [
    interpretModelFit({
      rSquared: result.rSquared,
      adjustedRSquared: result.adjustedRSquared,
      fStatistic: result.fStat,
      fPValue: result.fPValue,
      regressorCount: result.nFeatures,
      nObs: result.nObs,
      alpha: options.alpha,
    }),
  ];

  result.featureNames.forEach((name, index) => {
    const isInteraction = /[*:×]/.test(name);
    outputs.push(interpretCoefficient({
      name,
      estimate: result.coefficients[index],
      stdError: result.stdErrors[index + 1],
      statistic: result.tStats[index + 1],
      pValue: result.pValues[index + 1],
      confidenceInterval: result.ci95[index + 1],
      functionalForm: options.functionalForm,
      yName: result.yName,
      nObs: result.nObs,
      alpha: options.alpha,
      kind: isInteraction ? 'interaction' : dummyNames.has(name) ? 'dummy' : 'continuous',
      baseCategory: options.baseCategories?.[name],
    }));
  });

  outputs.push(interpretResiduals(result.residuals));
  if (result.method === 'RLS' && result.fStatConstraint !== undefined) {
    outputs.push(interpretWald({
      title: 'Restricción lineal (RLS/F)',
      statistic: result.fStatConstraint,
      pValue: result.fPValueConstraint,
      restrictions: result.jConstraints,
      hypothesis: result.rlsConstraint,
      alpha: options.alpha,
      nObs: result.nObs,
    }));
  }
  return outputs;
}

/** Legacy plain-text export used by downloads and older callers. */
export function interpret(result: RegressionResult, options: RegressionInterpretationOptions = {}): string {
  return interpretRegressionResult(result, options)
    .map(item => [item.title, item.summary, item.statisticalConclusion, item.practicalMeaning, ...item.limitations]
      .filter(Boolean).join('\n'))
    .join('\n\n');
}
