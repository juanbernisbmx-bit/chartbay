import { getValidRows, type ParsedCSV } from '../csvParser';
import { runOLS } from '../regression';
import { applyFunctionalTransform, type FunctionalForm } from '../functionalForms';
import { assertNumericY, encodeCategoricalX } from '../categoricalEncoding';

export interface FunctionalFormCandidate {
  form: FunctionalForm;
  valid: boolean;
  reasonIfInvalid?: string;
  metrics?: {
    rss: number;
    rSquared: number;
    adjustedRSquared: number;
    rmseOriginalScale: number;
    maeOriginalScale: number;
    improvementVsLinLin?: number;
  };
}

export interface FunctionalFormRecommendation {
  recommended: FunctionalForm | null;
  candidates: FunctionalFormCandidate[];
  warning?: string;
  note: string;
}

const FORM_ORDER: FunctionalForm[] = ['lin-lin', 'log-lin', 'lin-log', 'log-log'];

function computeRmse(actual: number[], predicted: number[]): number {
  const n = actual.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (actual[i] - predicted[i]) ** 2;
  return Math.sqrt(sum / n);
}

function computeMae(actual: number[], predicted: number[]): number {
  const n = actual.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(actual[i] - predicted[i]);
  return sum / n;
}

// Compare two valid candidates; returns negative if a is better (lower RMSE).
// Tiebreaking: RMSE → MAE → adj R² → form simplicity.
// Within-1% threshold triggers next criterion.
function compareValidCandidates(a: FunctionalFormCandidate, b: FunctionalFormCandidate): number {
  const ra = a.metrics!.rmseOriginalScale;
  const rb = b.metrics!.rmseOriginalScale;
  const rScale = Math.max(ra, rb);
  if (rScale > 0 && Math.abs(ra - rb) / rScale >= 0.01) return ra - rb;

  const ma = a.metrics!.maeOriginalScale;
  const mb = b.metrics!.maeOriginalScale;
  const mScale = Math.max(ma, mb);
  if (mScale > 0 && Math.abs(ma - mb) / mScale >= 0.01) return ma - mb;

  const adjDiff = b.metrics!.adjustedRSquared - a.metrics!.adjustedRSquared;
  if (Math.abs(adjDiff) > 0.001) return adjDiff;

  return FORM_ORDER.indexOf(a.form) - FORM_ORDER.indexOf(b.form);
}

export function recommendFunctionalForm(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
): FunctionalFormRecommendation {
  assertNumericY(csvData.rows, yName);

  // Expand categorical X into k-1 dummies so the recommender can compare
  // forms even when the selection mixes numeric and categorical variables.
  const encoding = encodeCategoricalX(csvData.rows, xNames);
  const effectiveXNames = encoding.expandedXNames;
  const dummyNames = new Set(encoding.categoricalInfo.flatMap(c => c.createdDummies));

  const { X: rawX, y: rawY } = getValidRows(encoding.rows, yName, effectiveXNames);
  const n = rawY.length;
  const k = effectiveXNames.length;
  const notEnoughObs = n < k + 2;

  const candidates: FunctionalFormCandidate[] = [];
  let linLinRmse: number | null = null;

  for (const form of FORM_ORDER) {
    if (notEnoughObs) {
      candidates.push({ form, valid: false, reasonIfInvalid: 'Observaciones insuficientes para estimar el modelo.' });
      continue;
    }

    const needsLogY = form === 'log-lin' || form === 'log-log';
    const needsLogX = form === 'lin-log' || form === 'log-log';

    if (needsLogY && rawY.some(v => v <= 0)) {
      const label = form === 'log-lin' ? 'Log-Lin' : 'Log-Log';
      candidates.push({
        form,
        valid: false,
        reasonIfInvalid: `${label} no es válido porque la variable Y contiene valores menores o iguales a cero. Los modelos con ln(Y) requieren valores estrictamente positivos.`,
      });
      continue;
    }

    // Dummy columns (0/1) are excluded from the log-X domain check — they are
    // never logged, so a 0 there does not invalidate lin-log / log-log.
    if (needsLogX && rawX.some(row => row.some((v, colIdx) => !dummyNames.has(effectiveXNames[colIdx]) && v <= 0))) {
      const label = form === 'lin-log' ? 'Lin-Log' : 'Log-Log';
      candidates.push({
        form,
        valid: false,
        reasonIfInvalid: `${label} no es válido porque una o más variables X contienen valores menores o iguales a cero. Los modelos con ln(X) requieren valores estrictamente positivos.`,
      });
      continue;
    }

    try {
      const transformed = applyFunctionalTransform(rawY, rawX, yName, effectiveXNames, form, dummyNames);
      const result = runOLS({
        X: transformed.X,
        y: transformed.y,
        featureNames: transformed.xNames,
        yName: transformed.yName,
      });

      // Back-transform predictions to original Y scale for fair comparison.
      // Log-Y models: exp(fitted). Lin-Y models: fitted directly.
      // No Duan smearing correction in this phase.
      const logY = form === 'log-lin' || form === 'log-log';
      const predOriginal = logY
        ? result.predictions.map(p => Math.exp(p))
        : result.predictions;

      const rss = result.residuals.reduce((s, r) => s + r * r, 0);
      const rmseVal = computeRmse(rawY, predOriginal);
      const maeVal = computeMae(rawY, predOriginal);

      if (form === 'lin-lin') linLinRmse = rmseVal;

      candidates.push({
        form,
        valid: true,
        metrics: {
          rss,
          rSquared: result.rSquared,
          adjustedRSquared: result.adjustedRSquared,
          rmseOriginalScale: rmseVal,
          maeOriginalScale: maeVal,
        },
      });
    } catch {
      candidates.push({
        form,
        valid: false,
        reasonIfInvalid: 'El modelo no pudo estimarse con los datos disponibles.',
      });
    }
  }

  // Improvement vs lin-lin (only when lin-lin was valid)
  if (linLinRmse !== null) {
    for (const c of candidates) {
      if (c.valid && c.metrics && c.form !== 'lin-lin') {
        c.metrics.improvementVsLinLin = 100 * (linLinRmse - c.metrics.rmseOriginalScale) / linLinRmse;
      }
    }
  }

  // Rank valid candidates
  const valid = candidates.filter(c => c.valid && c.metrics);
  valid.sort(compareValidCandidates);

  const recommended = valid.length > 0 ? valid[0].form : null;

  // Warning when the top two are within 1% RMSE
  let warning: string | undefined;
  if (valid.length >= 2) {
    const bestR = valid[0].metrics!.rmseOriginalScale;
    const secondR = valid[1].metrics!.rmseOriginalScale;
    const scale = Math.max(bestR, secondR);
    if (scale > 0 && Math.abs(bestR - secondR) / scale < 0.01) {
      warning = 'Varias formas funcionales tienen un ajuste muy similar. Preferí la forma más simple salvo que la teoría económica justifique una transformación.';
    }
  }

  const logYRecommended = recommended === 'log-lin' || recommended === 'log-log';
  let note = 'La recomendación es una guía estadística. La elección final debe considerar teoría económica, interpretación y diagnóstico de residuos.';
  if (logYRecommended) {
    note += ' Las predicciones de modelos con ln(Y) se compararon en escala original usando exp(fitted). No se aplicó corrección de smearing en esta fase.';
  }

  return { recommended, candidates, warning, note };
}
