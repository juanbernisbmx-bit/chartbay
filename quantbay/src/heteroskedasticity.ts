// Breusch-Pagan heteroskedasticity diagnostic — Quant Bay Phase 5.
//
// Runs an auxiliary regression of the squared residuals of the main model
// on the same regressors (already log-transformed / dummy-expanded as
// estimated) to test whether residual variance depends systematically on X.

import { runOLS } from './regression';
import { chi2PValue } from './statistics';

export type BreuschPaganVerdict = 'no_evidence' | 'evidence' | 'unavailable';

export interface BreuschPaganResult {
  available: boolean;
  statistic?: number;
  pValue?: number;
  df?: number;
  rSquaredAux?: number;
  n?: number;
  verdict: BreuschPaganVerdict;
  message: string;
  warnings: string[];
}

export const BREUSCH_PAGAN_NOTE =
  'Breusch-Pagan evalúa si la varianza de los residuos se relaciona sistemáticamente con las variables explicativas. ' +
  'No prueba causalidad y puede tener baja potencia en muestras chicas.';

const MSG_INSUFFICIENT_OBS = 'No hay suficientes observaciones para aplicar Breusch-Pagan.';
const MSG_NO_MATRIX =
  'El diagnóstico de heterocedasticidad no está disponible porque no hay una matriz de diseño válida para la regresión auxiliar.';
const MSG_NON_FINITE =
  'El diagnóstico de heterocedasticidad no está disponible porque los residuos o la matriz de diseño contienen valores no finitos.';
const MSG_NO_VARIATION = 'Los residuos no tienen variación suficiente para aplicar el test.';
const MSG_AUX_FAILED =
  'El diagnóstico de heterocedasticidad no está disponible porque la regresión auxiliar no pudo estimarse.';
const MSG_EVIDENCE =
  'Hay evidencia de heterocedasticidad. Los coeficientes OLS pueden seguir siendo insesgados, pero los errores ' +
  'estándar, t-stat y p-values clásicos pueden no ser confiables.';
const MSG_NO_EVIDENCE = 'No hay evidencia fuerte de heterocedasticidad con este test.';

function unavailable(message: string): BreuschPaganResult {
  return { available: false, verdict: 'unavailable', message, warnings: [] };
}

function hasVariation(values: number[]): boolean {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const scale = Math.max(1, Math.abs(mean));
  return values.some(v => Math.abs(v - mean) > 1e-10 * scale);
}

export function breuschPaganTest(args: {
  residuals: number[];
  designMatrix: number[][];
  regressorNames: string[];
}): BreuschPaganResult {
  const { residuals, designMatrix, regressorNames } = args;

  if (!residuals || residuals.length === 0) return unavailable(MSG_INSUFFICIENT_OBS);
  if (!designMatrix || designMatrix.length === 0 || !designMatrix[0] || designMatrix[0].length === 0) {
    return unavailable(MSG_NO_MATRIX);
  }
  if (designMatrix.length !== residuals.length) return unavailable(MSG_NO_MATRIX);

  const n = residuals.length;
  const df = designMatrix[0].length;

  if (df <= 0) return unavailable(MSG_NO_MATRIX);
  if (n <= df + 1) return unavailable(MSG_INSUFFICIENT_OBS);

  if (!residuals.every(Number.isFinite)) return unavailable(MSG_NON_FINITE);
  if (!designMatrix.every(row => row.length === df && row.every(Number.isFinite))) {
    return unavailable(MSG_NON_FINITE);
  }

  const eSquared = residuals.map(r => r * r);
  if (!hasVariation(eSquared)) return unavailable(MSG_NO_VARIATION);

  let aux;
  try {
    aux = runOLS({ X: designMatrix, y: eSquared, featureNames: regressorNames, yName: 'e2' });
  } catch {
    return unavailable(MSG_AUX_FAILED);
  }

  const rSquaredAux = Math.max(0, aux.rSquared);
  const statistic = n * rSquaredAux;
  const pValue = chi2PValue(statistic, df);
  if (!Number.isFinite(pValue)) return unavailable(MSG_AUX_FAILED);

  const verdict: BreuschPaganVerdict = pValue < 0.05 ? 'evidence' : 'no_evidence';
  const warnings: string[] = [];
  if (n < 30) warnings.push('Muestra pequeña (n < 30): el test puede tener baja potencia estadística.');

  return {
    available: true,
    statistic,
    pValue,
    df,
    rSquaredAux,
    n,
    verdict,
    message: verdict === 'evidence' ? MSG_EVIDENCE : MSG_NO_EVIDENCE,
    warnings,
  };
}
