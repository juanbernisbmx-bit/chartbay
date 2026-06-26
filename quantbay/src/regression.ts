import { tDistPValue, fDistPValue, tQuantile } from './statistics';

export interface RegressionInput {
  X: number[][];
  y: number[];
  featureNames: string[];
  yName: string;
  dropRedundant?: boolean;
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
  droppedFeatures?: Array<{ name: string; reason: string }>; // populated when dropRedundant: true
  // Optional: populated by runRLS, absent on plain OLS results
  method?: 'OLS' | 'RLS';
  rlsConstraint?: string;
  rssOLS?: number;
  rssRLS?: number;
  fStatConstraint?: number;
  fPValueConstraint?: number;
  jConstraints?: number;
  // false when stdErrors/tStats/pValues/ci95 are placeholders (NaN), not computed
  restrictedInferenceAvailable?: boolean;
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

// ── Rank-deficiency detection ─────────────────────────────────────────────────

interface RankIssue {
  colIdx: number;  // column index in the augmented design matrix Xd (0 = intercept)
  name: string;    // column name
  reason: string;  // human-readable explanation
}

// Modified Gram-Schmidt orthogonalization in natural column order.
// Columns are processed left to right so that, within any collinear group,
// the lowest-index column is kept and later ones are declared dependent.
// Returns the set of column indices in Xd that are linearly dependent on prior columns.
function findDependentColumns(Xd: number[][]): Set<number> {
  const n = Xd.length;
  const p = Xd[0].length;
  const cols = Array.from({ length: p }, (_, j) => Xd.map(row => row[j]));
  const maxNorm = Math.max(...cols.map(c => Math.sqrt(c.reduce((s, x) => s + x * x, 0))));
  const eps = 1e-10 * Math.sqrt(n) * maxNorm;

  const dependent = new Set<number>();
  const basis: number[][] = [];

  for (let j = 0; j < p; j++) {
    let v = cols[j].slice();
    for (const b of basis) {
      const proj = b.reduce((s, bi, i) => s + bi * v[i], 0);
      v = v.map((vi, i) => vi - proj * b[i]);
    }
    const norm = Math.sqrt(v.reduce((s, vi) => s + vi * vi, 0));
    if (norm < eps) {
      dependent.add(j);
    } else {
      basis.push(v.map(vi => vi / norm));
    }
  }

  return dependent;
}

// Given the augmented design matrix and all column names (allNames[0] = '(intercepto)'),
// returns null when the matrix has full rank, or a list of RankIssue descriptors otherwise.
function detectRankIssues(Xd: number[][], allNames: string[]): RankIssue[] | null {
  const dependentCols = findDependentColumns(Xd);
  if (dependentCols.size === 0) return null;

  const n = Xd.length;
  const p = Xd[0].length;
  const issues: RankIssue[] = [];
  const reported = new Set<number>();

  // Precompute per-column mean and standard deviation
  const colMeans = Array.from({ length: p }, (_, j) => {
    const col = Xd.map(row => row[j]);
    return col.reduce((s, x) => s + x, 0) / n;
  });
  const colStds = Array.from({ length: p }, (_, j) => {
    const col = Xd.map(row => row[j]);
    const m = colMeans[j];
    return Math.sqrt(col.reduce((s, x) => s + (x - m) ** 2, 0) / n);
  });

  // Case A: zero-variance feature column — constant, duplicates the automatic intercept
  for (const j of dependentCols) {
    if (j === 0) continue; // intercept itself is always independent
    const scale = Math.max(Math.abs(colMeans[j]), 1);
    if (colStds[j] / scale < 1e-10) {
      issues.push({
        colIdx: j,
        name: allNames[j],
        reason: `"${allNames[j]}" tiene varianza cero (columna constante) y duplica el intercepto automático del modelo.`,
      });
      reported.add(j);
    }
  }

  // Case B: near-perfect pairwise correlation with any independent column (|r| > 0.9999)
  for (const j of dependentCols) {
    if (reported.has(j)) continue;
    const sj = colStds[j];
    if (sj < 1e-15) continue; // constant — already handled above
    const mj = colMeans[j];
    const colJ = Xd.map(row => row[j]);

    let bestCorr = 0, bestI = -1;
    for (let i = 0; i < p; i++) {
      if (i === j || dependentCols.has(i)) continue;
      const si = colStds[i];
      if (si < 1e-15) continue; // skip constant columns (intercept, etc.)
      const mi = colMeans[i];
      const colI = Xd.map(row => row[i]);
      const cov = colI.reduce((s, xi, idx) => s + (xi - mi) * (colJ[idx] - mj), 0) / n;
      const corr = Math.abs(cov / (si * sj));
      if (corr > bestCorr) { bestCorr = corr; bestI = i; }
    }

    if (bestCorr > 0.9999 && bestI >= 0) {
      issues.push({
        colIdx: j,
        name: allNames[j],
        reason: `"${allNames[j]}" es perfectamente colineal con "${allNames[bestI]}" (|correlación| = ${bestCorr.toFixed(6)}).`,
      });
      reported.add(j);
    }
  }

  // Case C: remaining dependent columns — generic multicollinearity (e.g. X3 = X1 + X2)
  for (const j of dependentCols) {
    if (!reported.has(j)) {
      issues.push({
        colIdx: j,
        name: allNames[j],
        reason: `"${allNames[j]}" es combinación lineal de otras columnas del modelo.`,
      });
      reported.add(j);
    }
  }

  return issues;
}

// ── OLS ───────────────────────────────────────────────────────────────────────

export function runOLS(input: RegressionInput): RegressionResult {
  const { X, y, featureNames, yName, dropRedundant = false } = input;
  const n = y.length;
  const k = X[0].length;

  if (n < k + 2) {
    throw new Error(
      `Se necesitan al menos ${k + 2} observaciones para ${k} variable(s).`
    );
  }

  const Xd = X.map(row => [1, ...row]);
  const allNames = ['(intercepto)', ...featureNames];

  // ── Rank check — runs before inverting X'X ───────────────────────────────
  const rankIssues = detectRankIssues(Xd, allNames);

  if (rankIssues !== null) {
    if (!dropRedundant) {
      const lines = rankIssues.map(issue => `  • ${issue.reason}`).join('\n');
      throw new Error(
        `Deficiencia de rango en la matriz de diseño ` +
        `(${rankIssues.length} columna(s) redundante(s)):\n` +
        `${lines}\n\n` +
        `Corrija la colinealidad o active "dropRedundant: true" para excluir ` +
        `automáticamente las columnas redundantes.`
      );
    }

    // Auto-drop: remove redundant feature columns (never drop col 0 = intercept)
    const dropSet = new Set(rankIssues.map(r => r.colIdx).filter(j => j > 0));
    const keepCols = Array.from({ length: k }, (_, i) => i).filter(i => !dropSet.has(i + 1));
    const droppedFeatures = rankIssues
      .filter(r => r.colIdx > 0)
      .map(r => ({ name: r.name, reason: r.reason }));

    const cleanResult = runOLS({
      X: X.map(row => keepCols.map(i => row[i])),
      y,
      featureNames: keepCols.map(i => featureNames[i]),
      yName,
    });
    return { ...cleanResult, droppedFeatures };
  }

  // ── Normal OLS pipeline (unchanged from original) ─────────────────────────
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
