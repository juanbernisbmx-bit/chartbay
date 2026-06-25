import { getValidRows, type ParsedCSV } from '../csvParser';
import { computeVIF, runOLS, type RegressionResult } from '../regression';
import { pearsonMatrix } from '../statistics';

export interface LeakageSignal {
  name: string;
  r: number;
  abs: number;
}

export interface LogisticResult {
  intercept: number;
  coefficients: number[];
  oddsRatios: number[];
  mcFaddenR2: number;
  accuracy: number;
  llModel: number;
  llNull: number;
  featureNames: string[];
  yName: string;
  yVals: number[];
  n: number;
}

export interface AnalysisResult {
  result: RegressionResult;
  dropped: number;
  corrMatrix: number[][];
  corrColumns: string[];
  vifValues: number[];
  binary: boolean;
  leaks: LeakageSignal[];
  logitResult: LogisticResult | null;
}

export function getCompleteNumericColumns(
  rows: Record<string, unknown>[],
  colNames: string[]
): number[][] {
  const valid = rows.filter(row =>
    colNames.every(c => {
      const raw = row[c];
      if (raw === null || raw === undefined || raw === '') return false;
      const v = Number(raw);
      return !isNaN(v) && isFinite(v);
    })
  );
  return colNames.map(col => valid.map(row => Number(row[col])));
}

const LEAK_THRESHOLD = 0.95;

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0);
}

function sigmoid(z: number): number {
  if (z > 500) return 1;
  if (z < -500) return 0;
  return 1 / (1 + Math.exp(-z));
}

export function isBinaryTarget(y: number[]): boolean {
  return new Set(y).size === 2;
}

export function detectLeakage(
  X: number[][],
  y: number[],
  xNames: string[],
  threshold = LEAK_THRESHOLD
): LeakageSignal[] {
  const yMean = mean(y);
  const yDev = y.map(value => value - yMean);
  const yVar = yDev.reduce((sum, value) => sum + value * value, 0);

  return xNames
    .map((name, index) => {
      const xCol = X.map(row => row[index]);
      const xMean = mean(xCol);
      const xDev = xCol.map(value => value - xMean);
      const numerator = xDev.reduce((sum, value, rowIndex) => sum + value * yDev[rowIndex], 0);
      const denominator = Math.sqrt(xDev.reduce((sum, value) => sum + value * value, 0) * yVar);
      const r = denominator === 0 ? 0 : numerator / denominator;
      return { name, r, abs: Math.abs(r) };
    })
    .filter(signal => signal.abs >= threshold);
}

export function runLogistic({
  X,
  y,
  featureNames,
  yName,
  maxIter = 1500,
  lr = 0.05,
}: {
  X: number[][];
  y: number[];
  featureNames: string[];
  yName: string;
  maxIter?: number;
  lr?: number;
}): LogisticResult {
  const n = y.length;
  const yVals = [...new Set(y)].sort((a, b) => a - b);
  const yBin = y.map(value => (value === yVals[1] ? 1 : 0));
  const Xd = X.map(row => [1, ...row]);
  const p = Xd[0].length;

  let beta = new Array(p).fill(0);
  for (let iter = 0; iter < maxIter; iter++) {
    const probs = Xd.map(row => sigmoid(dot(beta, row)));
    const errors = probs.map((prob, index) => prob - yBin[index]);
    const gradient = Array.from({ length: p }, (_, col) =>
      Xd.reduce((sum, row, rowIndex) => sum + row[col] * errors[rowIndex], 0) / n
    );
    beta = beta.map((value, index) => value - lr * gradient[index]);
  }

  const probs = Xd.map(row => sigmoid(dot(beta, row)));
  const eps = 1e-15;
  const llModel = probs.reduce(
    (sum, prob, index) =>
      sum +
      yBin[index] * Math.log(Math.max(eps, prob)) +
      (1 - yBin[index]) * Math.log(Math.max(eps, 1 - prob)),
    0
  );
  const pMean = mean(yBin);
  const llNull =
    n *
    (pMean * Math.log(Math.max(eps, pMean)) +
      (1 - pMean) * Math.log(Math.max(eps, 1 - pMean)));
  const predicted = probs.map(prob => (prob >= 0.5 ? 1 : 0));

  return {
    intercept: beta[0],
    coefficients: beta.slice(1),
    oddsRatios: beta.slice(1).map(coef => Math.exp(coef)),
    mcFaddenR2: llNull !== 0 ? Math.max(0, 1 - llModel / llNull) : 0,
    accuracy: predicted.filter((prediction, index) => prediction === yBin[index]).length / n,
    llModel,
    llNull,
    featureNames,
    yName,
    yVals,
    n,
  };
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
  const binary = isBinaryTarget(y);
  const leaks = detectLeakage(X, y, xNames);
  let logitResult: LogisticResult | null = null;

  if (binary) {
    try {
      logitResult = runLogistic({ X, y, featureNames: xNames, yName });
    } catch {
      logitResult = null;
    }
  }

  return {
    result,
    dropped,
    corrMatrix: pearsonMatrix(allColData),
    corrColumns: csvData.numericColumns,
    vifValues: computeVIF(X),
    binary,
    leaks,
    logitResult,
  };
}
