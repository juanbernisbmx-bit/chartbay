import { runQuantAnalysis, type AnalysisOptions, type LeakageSignal, type LogisticResult } from '../services/analysisService';
import { runRLS, validateRLSConstraint, type RLSConstraint } from '../rls';
import { getValidRowsFrom, materializeRows, type ParsedCSV } from '../csvParser';
import { autoRepairAndAnalyze, type AutoRepairResult } from '../services/autoRepair';
import { runOLS, type RegressionResult } from '../regression';
import { applyFunctionalTransform, type FunctionalForm } from '../functionalForms';
import { assertNumericY, encodeForRegression, type CategoricalVariableInfo } from '../categoricalEncoding';
import { breuschPaganTest, type BreuschPaganResult } from '../heteroskedasticity';

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
  categoricalInfo: CategoricalVariableInfo[];
  categoricalWarnings: string[];
  heteroskedasticity: BreuschPaganResult;
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
  categoricalInfo: CategoricalVariableInfo[];
  categoricalWarnings: string[];
  heteroskedasticity: BreuschPaganResult;
}

export function runRegressionMode(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  rlsConstraint: RLSConstraint | undefined,
  functionalForm: FunctionalForm = 'lin-lin',
  options: AnalysisOptions = {},
): RegressionModeOutput {
  assertNumericY(csvData.rows, yName);

  // Expand categorical X columns into k-1 dummies before anything else touches
  // the design matrix. Numeric X columns pass through unchanged.
  const { encoding, effectiveCsvData } = encodeForRegression(csvData, xNames);
  const effectiveXNames = encoding.expandedXNames;
  const dummyNames = new Set(encoding.categoricalInfo.flatMap(c => c.createdDummies));

  // Run full analysis on original scale — provides validation, diagnostics, VIF, correlation.
  const analysis = runQuantAnalysis(effectiveCsvData, yName, effectiveXNames, options);

  // Get valid rows and apply the functional transform (identity for lin-lin).
  // applyFunctionalTransform throws clearly if log-domain values are invalid (<=0).
  // Dummy columns are excluded from the log-X transform (they must stay 0/1).
  const { X: rawX, y: rawY } = getValidRowsFrom(effectiveCsvData, yName, effectiveXNames);
  const transformed = applyFunctionalTransform(rawY, rawX, yName, effectiveXNames, functionalForm, dummyNames);

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

  const heteroskedasticity = breuschPaganTest({
    residuals: finalResult.residuals,
    designMatrix: transformed.X,
    regressorNames: transformed.xNames,
  });

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
    categoricalInfo: encoding.categoricalInfo,
    categoricalWarnings: encoding.warnings,
    heteroskedasticity,
  };
}

export function runAutoRegressionMode(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  rlsConstraint: RLSConstraint | undefined,
  functionalForm: FunctionalForm = 'lin-lin',
): AutoRegressionModeOutput {
  assertNumericY(csvData.rows, yName);

  // Expand categorical X columns into k-1 dummies before auto-repair runs.
  // Auto-repair treats dummy columns like any other numeric column — a
  // high-VIF or perfectly-collinear dummy can still be pruned.
  const { encoding, effectiveCsvData } = encodeForRegression(csvData, xNames);
  const dummyNames = new Set(encoding.categoricalInfo.flatMap(c => c.createdDummies));

  const analysis = autoRepairAndAnalyze(effectiveCsvData, yName, encoding.expandedXNames);

  // After auto-repair, use the surviving feature names for the functional transform.
  const survivingXNames = analysis.result.featureNames;
  const { X: rawX, y: rawY } = getValidRowsFrom(effectiveCsvData, yName, survivingXNames);
  const transformed = applyFunctionalTransform(rawY, rawX, yName, survivingXNames, functionalForm, dummyNames);

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

  const heteroskedasticity = breuschPaganTest({
    residuals: finalResult.residuals,
    designMatrix: transformed.X,
    regressorNames: transformed.xNames,
  });

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
    categoricalInfo: encoding.categoricalInfo,
    categoricalWarnings: encoding.warnings,
    heteroskedasticity,
  };
}
