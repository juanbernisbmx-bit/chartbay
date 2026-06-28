import { runQuantAnalysis, type LeakageSignal, type LogisticResult } from '../services/analysisService';
import { runRLS, validateRLSConstraint, type RLSConstraint } from '../rls';
import { getValidRows, type ParsedCSV } from '../csvParser';
import { autoRepairAndAnalyze, type AutoRepairResult } from '../services/autoRepair';
import type { RegressionResult } from '../regression';

export interface RegressionModeOutput {
  result: RegressionResult;
  method: 'OLS' | 'RLS';
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
): RegressionModeOutput {
  const analysis = runQuantAnalysis(csvData, yName, xNames);

  let finalResult = analysis.result;
  let method: 'OLS' | 'RLS' = 'OLS';
  const logEntries = [
    'Leyendo datos... OK',
    'Filtrando valores faltantes... OK',
    'Construyendo matriz de diseño... OK',
    'Estimando coeficientes OLS... OK',
  ];

  if (rlsConstraint) {
    try {
      validateRLSConstraint(rlsConstraint, xNames.length + 1);
      const { X, y } = getValidRows(csvData.rows, yName, xNames);
      finalResult = runRLS({ X, y, featureNames: xNames, yName }, rlsConstraint);
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
): AutoRegressionModeOutput {
  const analysis = autoRepairAndAnalyze(csvData, yName, xNames);

  let finalResult = analysis.result;
  let method: 'OLS' | 'RLS' = 'OLS';
  let rlsFallbackNote = '';

  if (rlsConstraint) {
    const finalXNames = finalResult.featureNames;
    const expectedParams = rlsConstraint.R[0]?.length ?? 0;
    const modelParams = finalXNames.length + 1;
    if (expectedParams !== modelParams) {
      rlsFallbackNote =
        `El modelo reparado se estimó como OLS porque la restricción "${rlsConstraint.label}" ` +
        `espera ${expectedParams} parámetros pero el modelo reparado tiene ${modelParams} ` +
        `(la reparación eliminó variables incluidas en la restricción).`;
    } else {
      try {
        const { X, y } = getValidRows(csvData.rows, yName, finalXNames);
        finalResult = runRLS({ X, y, featureNames: finalXNames, yName }, rlsConstraint);
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
    corrMatrix: analysis.corrMatrix,
    corrColumns: analysis.corrColumns,
    vifValues: analysis.vifValues,
    dropped: analysis.dropped,
    repairResult: analysis,
    rlsFallbackNote,
  };
}
