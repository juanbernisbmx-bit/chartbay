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
  const beta = matVecMul(matInv(matMul(Xt, Xd)), matVecMul(Xt, y));

  const intercept = beta[0];
  const coefficients = beta.slice(1);
  const predictions = Xd.map(row => dotProduct(beta, row));
  const residuals = y.map((yi, i) => yi - predictions[i]);

  const yMean = mean(y);
  const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  const ssRes = residuals.reduce((s, r) => s + r ** 2, 0);
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / (n - k - 1);

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
  };
}
