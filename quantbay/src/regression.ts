import { tDistPValue, fDistPValue, tQuantile } from './statistics';

export interface RegressionInput {
  X: number[][];
  y: number[];
  featureNames: string[];
  yName: string;
}

export interface RegressionResult {
  coefficients: number[];
  intercept: number;
  rSquared: number;
  adjustedRSquared: number;
  predictions: number[];
  residuals: number[];
  equation: string;
  featureNames: string[];
  yName: string;
  nObs: number;
  nFeatures: number;
  // Statistical inference
  stdErrors: number[];               // length k+1: [intercept, β₁, …, βₖ]
  tStats: number[];
  pValues: number[];
  ci95: [number, number][];          // 95% CI for each coefficient: [[lo, hi], ...]
  df: number;                        // n − k − 1
  sigma2: number;                    // residual variance
  fStat: number;                     // F-statistic for overall model significance
  fPValue: number;                   // p-value of F-test (H₀: all slopes = 0)
}

export function transpose(A: number[][]): number[][] {
  const rows = A.length, cols = A[0].length;
  return Array.from({ length: cols }, (_, j) =>
    Array.from({ length: rows }, (_, i) => A[i][j])
  );
}

export function matMul(A: number[][], B: number[][]): number[][] {
  const m = A.length, n = B[0].length;
  return Array.from({ length: m }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      A[i].reduce((s, _, k) => s + A[i][k] * B[k][j], 0)
    )
  );
}

export function matVecMul(A: number[][], v: number[]): number[] {
  return A.map(row => dotProduct(row, v));
}

export function dotProduct(a: number[], b: number[]): number {
  return a.reduce((s, ai, i) => s + ai * b[i], 0);
}

export function mean(arr: number[]): number {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

export function matInv(A: number[][]): number[][] {
  const n = A.length;
  const aug = A.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col])) maxRow = r;
    }
    [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

    const pivot = aug[col][col];
    if (Math.abs(pivot) < 1e-12) {
      throw new Error('Matriz singular: las variables pueden ser colineales.');
    }

    for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r !== col) {
        const f = aug[r][col];
        for (let j = 0; j < 2 * n; j++) aug[r][j] -= f * aug[col][j];
      }
    }
  }

  return aug.map(row => row.slice(n));
}

export function runOLS(input: RegressionInput): RegressionResult {
  const { X, y, featureNames, yName } = input;
  const n = y.length;
  const k = X[0].length;

  if (n < k + 2) {
    throw new Error(
      `Se necesitan al menos ${k + 2} observaciones para ${k} variable(s).`
    );
  }

  const Xd = X.map(row => [1, ...row]);
  const Xt = transpose(Xd);
  const XtX = matMul(Xt, Xd);
  const XtXinv = matInv(XtX);
  const Xty = matVecMul(Xt, y);
  const beta = matVecMul(XtXinv, Xty);

  const intercept = beta[0];
  const coefficients = beta.slice(1);
  const predictions = Xd.map(row => dotProduct(beta, row));
  const residuals = y.map((yi, i) => yi - predictions[i]);

  const yMean = mean(y);
  const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  const ssRes = residuals.reduce((s, r) => s + r ** 2, 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const df = n - k - 1;
  const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / df;
  const sigma2 = df > 0 ? ssRes / df : 0;

  // Standard errors: SE(βᵢ) = sqrt(σ² * (X'X)⁻¹ᵢᵢ)
  const stdErrors = XtXinv.map((row, i) => Math.sqrt(Math.max(0, sigma2 * row[i])));
  const tStats = beta.map((b, i) => stdErrors[i] > 1e-15 ? b / stdErrors[i] : Infinity);
  const pValues = tStats.map(t => tDistPValue(t, df));

  // F-statistic: (R²/k) / ((1-R²)/df) — tests H₀: all slopes = 0
  const fStat = k > 0 && df > 0 ? (rSquared / k) / ((1 - rSquared) / df) : 0;
  const fPValue = fDistPValue(fStat, k, df);

  // 95% confidence intervals: β ± t(0.025, df) * SE
  const tCrit = tQuantile(0.05, df);
  const ci95 = beta.map((b, i) => [b - tCrit * stdErrors[i], b + tCrit * stdErrors[i]] as [number, number]);

  const terms = coefficients
    .map(
      (c, i) =>
        `${c >= 0 ? ' + ' : ' - '}${Math.abs(c).toFixed(4)}·${featureNames[i]}`
    )
    .join('');
  const equation = `${yName} = ${intercept.toFixed(4)}${terms}`;

  return {
    coefficients,
    intercept,
    rSquared,
    adjustedRSquared,
    predictions,
    residuals,
    equation,
    featureNames,
    yName,
    nObs: n,
    nFeatures: k,
    stdErrors,
    tStats,
    pValues,
    ci95,
    df,
    sigma2,
    fStat,
    fPValue,
  };
}

// Variance Inflation Factor for each predictor in X (n×k matrix)
export function computeVIF(X: number[][]): number[] {
  const k = X[0]?.length ?? 0;
  if (k <= 1) return new Array(k).fill(1);

  return Array.from({ length: k }, (_, j) => {
    const yVIF = X.map(row => row[j]);
    const xOther = X.map(row => row.filter((_, c) => c !== j));
    try {
      const res = runOLS({
        X: xOther,
        y: yVIF,
        featureNames: xOther[0].map((_, i) => `x${i}`),
        yName: `x${j}`,
      });
      const r2 = Math.max(0, res.rSquared);
      if (r2 >= 1 - 1e-10) return Infinity;
      return 1 / (1 - r2);
    } catch {
      return Infinity;
    }
  });
}
