/**
 * Auto-repair module for ChartBay.
 * Detects and fixes: perfect collinearity, singular matrix,
 * high VIF (multicollinearity), and insufficient observations.
 * Returns a structured log of every action taken and its statistical rationale.
 */
import { getValidRowsFrom, type ParsedCSV } from '../csvParser';
import { computeVIF, runOLS } from '../regression';
import { pearsonMatrix } from '../statistics';
import {
  getCompleteNumericColumnsFrom,
  isBinaryTarget,
  detectLeakage,
  runLogistic,
  type AnalysisResult,
} from './analysisService';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RepairReason =
  | 'perfect_collinearity'  // |r| ≥ 0.9999 between two X variables
  | 'singular_matrix'       // XtX is singular even after collinearity check
  | 'high_vif'              // VIF > 10 after OLS succeeds
  | 'insufficient_obs';     // n < k+2 after filtering NAs

export interface RepairAction {
  removed: string;
  reason: RepairReason;
  detail: string;       // plain-language explanation
  valueBefore?: number; // the problematic metric (r, VIF, etc.)
}

export interface AutoRepairResult extends AnalysisResult {
  actions: RepairAction[];
  originalXNames: string[];
  finalXNames: string[];
  repaired: boolean;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function pearsonR(a: number[], b: number[]): number {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da2 = 0, db2 = 0;
  for (let i = 0; i < n; i++) {
    num  += (a[i] - ma) * (b[i] - mb);
    da2  += (a[i] - ma) ** 2;
    db2  += (b[i] - mb) ** 2;
  }
  const denom = Math.sqrt(da2 * db2);
  return denom === 0 ? 0 : num / denom;
}

// ── Main function ─────────────────────────────────────────────────────────────

export function autoRepairAndAnalyze(
  csvData: ParsedCSV,
  yName: string,
  xNamesInput: string[]
): AutoRepairResult {
  const actions: RepairAction[] = [];
  let xNames = [...xNamesInput];

  function getData() {
    // Reads the typed columns directly when the dataset came from the WASM
    // cleaner, so the repeated re-fits below walk Float64Arrays instead of
    // rebuilding the design matrix out of row objects each time.
    return getValidRowsFrom(csvData, yName, xNames);
  }

  // ── STEP 1: Remove perfectly collinear X pairs (|r| ≥ 0.9999) ────────────
  // These would make XtX singular before we even try OLS.
  // We keep the variable with higher |r| with Y (more informative).
  let collinearClean = false;
  while (!collinearClean && xNames.length > 1) {
    const { X, y } = getData();
    const cols = xNames.map((_, j) => X.map(row => row[j]));
    let found = false;

    outer: for (let i = 0; i < cols.length; i++) {
      for (let j = i + 1; j < cols.length; j++) {
        const r = Math.abs(pearsonR(cols[i], cols[j]));
        if (r < 0.9999) continue;

        const ri = Math.abs(pearsonR(cols[i], y));
        const rj = Math.abs(pearsonR(cols[j], y));
        const toRemove = ri <= rj ? i : j;
        const kept     = toRemove === i ? j : i;
        const name     = xNames[toRemove];

        actions.push({
          removed: name,
          reason: 'perfect_collinearity',
          valueBefore: r,
          detail:
            `"${name}" tiene correlación de ${r.toFixed(4)} con "${xNames[kept]}" — ` +
            `prácticamente perfecta (umbral: 0.9999). Se eliminó porque su correlación ` +
            `con "${yName}" (r = ${ri.toFixed(4)}) era menor que la de ` +
            `"${xNames[kept]}" (r = ${rj.toFixed(4)}). Mantener ambas hace ` +
            `la matriz X'X singular, imposibilitando la inversión necesaria para OLS.`,
        });
        xNames.splice(toRemove, 1);
        found = true;
        break outer;
      }
    }
    if (!found) collinearClean = true;
  }

  // ── STEP 2: Try OLS; if singular, remove most redundant X and retry ───────
  let olsOk = false;
  const maxAttempts = xNamesInput.length + 1;

  for (let attempt = 0; attempt < maxAttempts && !olsOk; attempt++) {
    if (xNames.length === 0) break;
    const { X, y } = getData();

    // Not enough observations
    if (y.length < xNames.length + 2) {
      if (xNames.length === 1) break;
      const cols = xNames.map((_, j) => X.map(row => row[j]));
      let worstIdx = 0, worstCorr = Infinity;
      for (let i = 0; i < cols.length; i++) {
        const r = Math.abs(pearsonR(cols[i], y));
        if (r < worstCorr) { worstCorr = r; worstIdx = i; }
      }
      const name = xNames[worstIdx];
      actions.push({
        removed: name,
        reason: 'insufficient_obs',
        detail:
          `Solo hay ${y.length} observación(es) válidas para ${xNames.length} predictora(s) ` +
          `(se necesitan ≥ ${xNames.length + 2} para tener grados de libertad). ` +
          `Se eliminó "${name}" (la menos correlacionada con "${yName}", ` +
          `r = ${worstCorr.toFixed(4)}) para recuperar grados de libertad residual.`,
      });
      xNames.splice(worstIdx, 1);
      continue;
    }

    try {
      runOLS({ X, y, featureNames: xNames, yName });
      olsOk = true;
    } catch (err) {
      const msg = String((err as Error).message ?? '');
      const isSingular = msg.toLowerCase().includes('singular') ||
                         msg.toLowerCase().includes('colineal');
      if (!isSingular || xNames.length === 1) throw err;

      // Remove the X with the highest average |r| with the other Xs (most redundant)
      const cols = xNames.map((_, j) => X.map(row => row[j]));
      let worstIdx = 0, worstAvg = -1;
      for (let i = 0; i < cols.length; i++) {
        let sum = 0;
        for (let j = 0; j < cols.length; j++) {
          if (j !== i) sum += Math.abs(pearsonR(cols[i], cols[j]));
        }
        const avg = sum / (cols.length - 1);
        if (avg > worstAvg) { worstAvg = avg; worstIdx = i; }
      }
      const name = xNames[worstIdx];
      actions.push({
        removed: name,
        reason: 'singular_matrix',
        valueBefore: worstAvg,
        detail:
          `La matriz X'X resultó singular: al menos dos variables son linealmente ` +
          `dependientes. Se eliminó "${name}" porque tiene la correlación promedio más ` +
          `alta con las demás predictoras (r̄ = ${worstAvg.toFixed(4)}), ` +
          `lo que indica que es la más redundante del conjunto.`,
      });
      xNames.splice(worstIdx, 1);
    }
  }

  if (xNames.length === 0) {
    throw new Error('No fue posible construir un modelo válido con las variables seleccionadas.');
  }

  // ── STEP 3: VIF — iteratively remove the highest-VIF variable until VIF ≤ 10
  // Rationale: VIF = 1/(1 - R²_j) where R²_j is from regressing X_j on the
  // other Xs. VIF > 10 → R²_j > 0.90 → the variable shares >90% of its
  // variance with others, inflating standard errors and making coefficients
  // unstable and difficult to interpret.
  const VIF_THRESHOLD = 10;
  let vifClean = false;

  while (!vifClean && xNames.length > 1) {
    const { X, y } = getData();
    const vifs = computeVIF(X);
    const maxVif = Math.max(...vifs);
    if (maxVif <= VIF_THRESHOLD) { vifClean = true; break; }

    const worstIdx = vifs.indexOf(maxVif);
    const name     = xNames[worstIdx];
    const vifStr   = isFinite(maxVif) ? maxVif.toFixed(1) : '>999';

    actions.push({
      removed: name,
      reason: 'high_vif',
      valueBefore: maxVif,
      detail:
        `"${name}" tiene VIF = ${vifStr} (umbral: ${VIF_THRESHOLD}). ` +
        `El VIF mide cuánto se inflaron los errores estándar de este coeficiente por ` +
        `multicolinealidad. Un VIF > 10 indica que esta variable comparte más del 90 % ` +
        `de su varianza con las demás predictoras, haciendo sus coeficientes inestables ` +
        `e interpretaciones poco confiables. Se eliminó y se re-estimó el modelo.`,
    });
    xNames.splice(worstIdx, 1);

    // Re-run to confirm the reduced model is valid
    try {
      const { X: Xr, y: yr } = getData();
      runOLS({ X: Xr, y: yr, featureNames: xNames, yName });
    } catch {
      break;
    }
  }

  // ── Final model ───────────────────────────────────────────────────────────
  const { X: Xf, y: yf, dropped } = getData();
  const finalResult = runOLS({ X: Xf, y: yf, featureNames: xNames, yName });
  const allColData  = getCompleteNumericColumnsFrom(csvData);
  const binary      = isBinaryTarget(yf);
  const leaks       = detectLeakage(Xf, yf, xNames);
  let   logitResult = null;

  if (binary) {
    try {
      logitResult = runLogistic({ X: Xf, y: yf, featureNames: xNames, yName });
    } catch { /* ignore */ }
  }

  return {
    result:       finalResult,
    dropped,
    corrMatrix:   pearsonMatrix(allColData),
    corrColumns:  csvData.numericColumns,
    vifValues:    computeVIF(Xf),
    binary,
    leaks,
    logitResult,
    actions,
    originalXNames: xNamesInput,
    finalXNames:  [...xNames],
    repaired:     actions.length > 0,
  };
}
