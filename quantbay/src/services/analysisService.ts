import { getValidRows, type ParsedCSV } from '../csvParser';
import { computeVIF, runOLS, type RegressionResult } from '../regression';
import { pearsonMatrix } from '../statistics';

export interface AnalysisResult {
  result: RegressionResult;
  dropped: number;
  corrMatrix: number[][];
  corrColumns: string[];
  vifValues: number[];
}

export function getCompleteNumericColumns(
  rows: Record<string, unknown>[],
  colNames: string[]
): number[][] {
  const valid = rows.filter(row =>
    colNames.every(c => {
      const v = Number(row[c]);
      return !isNaN(v) && isFinite(v);
    })
  );
  return colNames.map(col => valid.map(row => Number(row[col])));
}

export function runQuantAnalysis(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[]
): AnalysisResult {
  const { X, y, dropped } = getValidRows(csvData.rows, yName, xNames);
  if (y.length < xNames.length + 2) {
    throw new Error(`Observaciones insuficientes (${y.length}) para ${xNames.length} variable(s).`);
  }

  const result = runOLS({ X, y, featureNames: xNames, yName });
  const allColData = getCompleteNumericColumns(csvData.rows, csvData.numericColumns);

  return {
    result,
    dropped,
    corrMatrix: pearsonMatrix(allColData),
    corrColumns: csvData.numericColumns,
    vifValues: computeVIF(X),
  };
}
