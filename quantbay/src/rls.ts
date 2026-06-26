import {
  matMul, matVecMul, matInv, transpose, dotProduct, mean,
  runOLS, type RegressionInput, type RegressionResult,
} from './regression';
import { fDistPValue } from './statistics';

// R * beta = q  (J restrictions, R is J×(k+1), q is J-vector)
// Coefficients indexed as [beta0, beta1, ..., betak]
export interface RLSConstraint {
  R: number[][];
  q: number[];
  label: string;
}

// beta_RLS = beta_OLS - (X'X)^-1 R' [R (X'X)^-1 R']^-1 (R beta_OLS - q)
export function runRLS(input: RegressionInput, constraint: RLSConstraint): RegressionResult {
  const { X, y, featureNames, yName } = input;
  const n = y.length;
  const k = X[0].length;

  // Unrestricted OLS (may throw on rank deficiency — intentional)
  const ols = runOLS(input);
  const rssOLS = ols.residuals.reduce((s, r) => s + r * r, 0);

  const Xd = X.map(row => [1, ...row]);
  const Xt = transpose(Xd);
  const XtX = matMul(Xt, Xd);
  const XtXinv = matInv(XtX);
  const betaOLS = [ols.intercept, ...ols.coefficients];

  const { R, q } = constraint;
  const J = R.length;

  if (R[0].length !== k + 1) {
    throw new Error(
      `La restricción tiene ${R[0].length} columnas pero el modelo tiene ${k + 1} parámetros ` +
      `([intercepto, ${featureNames.join(', ')}]). Verificá que la demo cargada corresponde a las variables seleccionadas.`
    );
  }

  // R * beta_OLS - q
  const Rbeta_q = R.map((row, i) => dotProduct(row, betaOLS) - q[i]);

  // R * (X'X)^-1 * R'
  const Rt = transpose(R);
  const RXtXinv = matMul(R, XtXinv);
  const RXtXinvRt = matMul(RXtXinv, Rt);

  // correction = (X'X)^-1 R' [R (X'X)^-1 R']^-1 (R beta_OLS - q)
  const correction = matVecMul(XtXinv, matVecMul(Rt, matVecMul(matInv(RXtXinvRt), Rbeta_q)));
  const betaRLS = betaOLS.map((b, i) => b - correction[i]);

  const predictions = Xd.map(row => dotProduct(betaRLS, row));
  const residuals = y.map((yi, i) => yi - predictions[i]);
  const rssRLS = residuals.reduce((s, r) => s + r * r, 0);

  const yMean = mean(y);
  const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  const df = n - k - 1;
  const rSquared = ssTot === 0 ? 0 : 1 - rssRLS / ssTot;
  const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / df;

  // F = [(RSS_RLS - RSS_OLS)/J] / [RSS_OLS/df]
  const fStatConstraint = df > 0 && rssOLS > 1e-15
    ? ((rssRLS - rssOLS) / J) / (rssOLS / df)
    : 0;
  const fPValueConstraint = fDistPValue(Math.max(0, fStatConstraint), J, df);

  const interceptRLS = betaRLS[0];
  const coefRLS = betaRLS.slice(1);
  const terms = coefRLS
    .map((c, i) => `${c >= 0 ? ' + ' : ' - '}${Math.abs(c).toFixed(4)}·${featureNames[i]}`)
    .join('');

  return {
    ...ols,
    coefficients: coefRLS,
    intercept: interceptRLS,
    predictions,
    residuals,
    rSquared,
    adjustedRSquared,
    equation: `${yName} = ${interceptRLS.toFixed(4)}${terms}`,
    method: 'RLS',
    rlsConstraint: constraint.label,
    rssOLS,
    rssRLS,
    fStatConstraint,
    fPValueConstraint,
    jConstraints: J,
  };
}
