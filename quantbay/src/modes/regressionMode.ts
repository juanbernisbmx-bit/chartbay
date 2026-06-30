import { runQuantAnalysis, type LeakageSignal, type LogisticResult } from '../services/analysisService';
import { runRLS, validateRLSConstraint, type RLSConstraint } from '../rls';
import { getValidRows, type ParsedCSV } from '../csvParser';
import { autoRepairAndAnalyze, type AutoRepairResult } from '../services/autoRepair';
import { runOLS, type RegressionResult } from '../regression';
import { applyFunctionalTransform, type FunctionalForm } from '../functionalForms';

export interface RegressionModeOutput {
  result: RegressionResult;
  method: 'OLS' | 'RLS';
  functionalForm: FunctionalForm;
  corrMatrix: number[][];
  corrColumns: string[];
  vifValues: number[];
  logitResult: LogisticResult | null;
  binary: boolean;
  leaks: LeakageSignal[];
  dropped: number;
  logEntries: string[];
}

export interface AutoRegressionModeOutput {
  result: RegressionResult;
  method: 'OLS' | 'RLS';
  functionalForm: FunctionalForm;
  corrMatrix: number[][];
  corrColumns: string[];
  vifValues: number[];
  dropped: number;
  repairResult: AutoRepairResult;
  rlsFallbackNote: string;
}

export function runRegressionMode(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  rlsConstraint: RLSConstraint | undefined,
  functionalForm: FunctionalForm = 'lin-lin',
): RegressionModeOutput {
  // Run full analysis on original scale — provides validation, diagnostics, VIF, correlation.
  const analysis = runQuantAnalysis(csvData, yName, xNames);

  // Get valid rows and apply the functional transform (identity for lin-lin).
  // applyFunctionalTransform throws clearly if log-domain values are invalid (<=0).
  const { X: rawX, y: rawY } = getValidRows(csvData.rows, yName, xNames);
  const transformed = applyFunctionalTransform(rawY, rawX, yName, xNames, functionalForm);

  let finalResult = functionalForm === 'lin-lin'
    ? analysis.result
    : runOLS({ X: transformed.X, y: transformed.y, featureNames: transformed.xNames, yName: transformed.yName });

  let method: 'OLS' | 'RLS' = 'OLS';
  const logEntries = [
    'Leyendo datos... OK',
    'Filtrando valores faltantes... OK',
    'Construyendo matriz de diseño... OK',
    `Forma funcional: ${functionalForm}... OK`,
    'Estimando coeficientes OLS... OK',
  ];

  if (rlsConstraint) {
    try {
      validateRLSConstraint(rlsConstraint, transformed.xNames.length + 1);
      finalResult = runRLS(
        { X: transformed.X, y: transformed.y, featureNames: transformed.xNames, yName: transformed.yName },
        rlsConstraint
      );
      logEntries.push(`Aplicando restricción RLS: ${rlsConstraint.label}... OK`);
      method = 'RLS';
    } catch (rlsErr) {
      const message = (rlsErr as Error).message;
      logEntries.push(`Restricción RLS no pudo aplicarse: ${message}`);
      throw new Error(`No se pudo aplicar la restricción RLS "${rlsConstraint.label}": ${message}`);
    }
  }
  logEntries.push('Calculando diagnósticos... OK');

  return {
    result: finalResult,
    method,
    functionalForm,
    corrMatrix: analysis.corrMatrix,
    corrColumns: analysis.corrColumns,
    vifValues: analysis.vifValues,
    logitResult: analysis.logitResult,
    binary: analysis.binary,
    leaks: analysis.leaks,
    dropped: analysis.dropped,
    logEntries,
  };
}

export function runAutoRegressionMode(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  rlsConstraint: RLSConstraint | undefined,
  functionalForm: FunctionalForm = 'lin-lin',
): AutoRegressionModeOutput {
  const analysis = autoRepairAndAnalyze(csvData, yName, xNames);

  // After auto-repair, use the surviving feature names for the functional transform.
  const survivingXNames = analysis.result.featureNames;
  const { X: rawX, y: rawY } = getValidRows(csvData.rows, yName, survivingXNames);
  const transformed = applyFunctionalTransform(rawY, rawX, yName, survivingXNames, functionalForm);

  let finalResult = functionalForm === 'lin-lin'
    ? analysis.result
    : runOLS({ X: transformed.X, y: transformed.y, featureNames: transformed.xNames, yName: transformed.yName });

  let method: 'OLS' | 'RLS' = 'OLS';
  let rlsFallbackNote = '';

  if (rlsConstraint) {
    const expectedParams = rlsConstraint.R[0]?.length ?? 0;
    const modelParams = transformed.xNames.length + 1;
    if (expectedParams !== modelParams) {
      rlsFallbackNote =
        `El modelo reparado se estimó como OLS porque la restricción "${rlsConstraint.label}" ` +
        `espera ${expectedParams} parámetros pero el modelo reparado tiene ${modelParams} ` +
        `(la reparación eliminó variables incluidas en la restricción).`;
    } else {
      try {
        finalResult = runRLS(
          { X: transformed.X, y: transformed.y, featureNames: transformed.xNames, yName: transformed.yName },
          rlsConstraint
        );
        method = 'RLS';
      } catch (rlsErr) {
        rlsFallbackNote =
          `El modelo reparado se estimó como OLS porque la restricción RLS no pudo aplicarse: ` +
          `${(rlsErr as Error).message}.`;
      }
    }
  }

  return {
    result: finalResult,
    method,
    functionalForm,
    corrMatrix: analysis.corrMatrix,
    corrColumns: analysis.corrColumns,
    vifValues: analysis.vifValues,
    dropped: analysis.dropped,
    repairResult: analysis,
    rlsFallbackNote,
  };
}
