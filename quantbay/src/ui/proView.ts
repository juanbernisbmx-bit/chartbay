import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import {
  DEFAULT_PRO_STANDARD_ERROR_TYPE,
  PRO_STANDARD_ERROR_LABELS,
  getProCovarianceInfo,
  type PyodideBreuschPagan,
  type PyodideOlsResult,
  type PyodideRlsTest,
  type ProStandardErrorType,
} from '../pro/pyodide/proResultTypes';
import type { CategoricalVariableInfo } from '../categoricalEncoding';
import { FORM_LABELS } from './formRecommendView';
import { interpretProResult } from '../pro/proInterpretation';
import { renderInterpretationResults } from './interpretationView';
import { buildModelDoctor, engineFindingFromInterpretation } from '../modelDoctor';
import { renderModelDoctor } from './modelDoctorView';
import { appState } from '../app/state';
import { createProModelSnapshot } from '../pro/modelComparisonSnapshot';
import { captureCurrentModel } from './modelComparisonView';

export type ProComparisonRow = {
  name: string;
  liteEstimate: number;
  proEstimate: number;
};

// Comparison of the restriction test itself (Lite's classical restricted-vs-
// unrestricted F-test, from rls.ts, against Pro's Wald/F test via statsmodels'
// f_test). These use different code paths but the same formula, so they are
// expected to agree numerically — unlike coefficients, which are NEVER
// compared while a restriction is active (Lite re-estimates β under Rβ = q,
// Pro does not).
export type ProRlsComparison = {
  label: string;
  liteFStat: number | null;
  litePValue: number | null;
};

export type ProComparison = {
  rows: ProComparisonRow[];
  liteRSquared: number | null;
  liteNobs: number | null;
  rlsTest?: ProRlsComparison | null;
  // Present when Lite and Pro built different design matrices for this run
  // (e.g. a categorical divergence) — the comparison is skipped entirely and
  // this message is shown instead of a coefficient/R² table.
  designMismatch?: string;
};

const fmt = (value: number): string => {
  if (!Number.isFinite(value)) return '—';
  // Perfect fits produce astronomically large t/F values; keep them readable.
  return Math.abs(value) >= 1e6 ? value.toExponential(4) : value.toFixed(6);
};
const fmtOpt = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : fmt(value);

export function showProPanel(): void {
  const panel = $('qb-pro-results');
  if (panel) panel.style.display = '';
}

// El selector de errores estándar solo tiene sentido cuando el motor Pro
// (Pyodide) está activo: oculto para Lite (siempre clásicos) y Mega Pro (bloqueado).
export function setProSeSelectorVisible(visible: boolean): void {
  const wrap = $('qb-pro-se-wrap');
  if (wrap) wrap.style.display = visible ? '' : 'none';
}

/**
 * Lee el valor crudo del selector de errores estándar Pro. Devuelve el default
 * ('classic') si el selector no existe (ej: flujo Lite sin el control montado);
 * la validación real del valor la hace el runner antes de ejecutar Python.
 */
export function getSelectedProStandardErrorType(): string {
  const select = $('qb-pro-se') as HTMLSelectElement | null;
  return select?.value ?? DEFAULT_PRO_STANDARD_ERROR_TYPE;
}

/**
 * Rezagos de Newey-West. Vacío = automático: Python aplica la regla de dedo
 * L = floor(4·(n/100)^(2/9)), que necesita el n y por eso no se resuelve acá.
 * Un valor no numérico devuelve NaN a propósito, para que lo rechace la
 * validación del runner con un mensaje, en vez de colarse como automático.
 */
export function getSelectedProHacMaxLags(): number | null {
  const input = $('qb-pro-hac-lags') as HTMLInputElement | null;
  const raw = input?.value.trim() ?? '';
  if (raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
}

export function hideProPanel(): void {
  const panel = $('qb-pro-results');
  if (panel) panel.style.display = 'none';
  showProStatus('');
  const error = $('qb-pro-error');
  if (error) { error.textContent = ''; error.style.display = 'none'; }
  const content = $('qb-pro-content');
  if (content) content.style.display = 'none';
  const doctor = $('qb-pro-model-doctor');
  if (doctor) doctor.innerHTML = '';
}

export function showProStatus(text: string): void {
  const el = $('qb-pro-status');
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}

/**
 * Clears any previous Pro result before a new run starts, so stale
 * coefficients/R²/inferencia/comparación from a prior calculation are never
 * visible while the new run is loading or executing.
 */
export function clearProResult(): void {
  const content = $('qb-pro-content');
  if (content) content.style.display = 'none';
  const error = $('qb-pro-error');
  if (error) { error.textContent = ''; error.style.display = 'none'; }
  const coefBody = $('qb-pro-coef-body');
  if (coefBody) coefBody.innerHTML = '';
  const statsBody = $('qb-pro-stats-body');
  if (statsBody) statsBody.innerHTML = '';
  const inferenceEl = $('qb-pro-inference');
  if (inferenceEl) inferenceEl.innerHTML = '';
  const categoricalEl = $('qb-pro-categorical');
  if (categoricalEl) categoricalEl.innerHTML = '';
  const rlsTestEl = $('qb-pro-rls-test');
  if (rlsTestEl) rlsTestEl.innerHTML = '';
  const bpTestEl = $('qb-pro-bp-test');
  if (bpTestEl) bpTestEl.innerHTML = '';
  const warningsEl = $('qb-pro-warnings');
  if (warningsEl) warningsEl.innerHTML = '';
  const comparisonEl = $('qb-pro-comparison');
  if (comparisonEl) comparisonEl.innerHTML = '';
  const doctorEl = $('qb-pro-model-doctor');
  if (doctorEl) doctorEl.innerHTML = '';
}

function showProError(message: string): void {
  const error = $('qb-pro-error');
  if (error) {
    error.innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
    error.style.display = '';
  }
  const content = $('qb-pro-content');
  if (content) content.style.display = 'none';
}

export function renderProResult(result: PyodideOlsResult, comparison?: ProComparison | null): void {
  showProPanel();
  showProStatus('');

  if (!result.ok) {
    showProError(result.error ?? 'Error desconocido en el motor Pro.');
    const doctor = $('qb-pro-model-doctor');
    if (doctor) doctor.innerHTML = renderModelDoctor(buildModelDoctor([], {
      mode: 'regression', engine: 'pro', nObs: 0, droppedRows: 0, paramCount: 0,
      hasIntercept: true, standardErrorType: 'classic', hacMaxLags: null,
      functionalForm: 'lin-lin', hasCategorical: false, droppedFeatures: [],
      hasRestriction: false, binaryTarget: false, datasetHasDates: false,
      alpha: 0.05, converged: false,
    }));
    return;
  }

  const error = $('qb-pro-error');
  if (error) { error.textContent = ''; error.style.display = 'none'; }

  const categoricalEl = $('qb-pro-categorical');
  if (categoricalEl) {
    categoricalEl.innerHTML = result.categoricalInfo && result.categoricalInfo.length > 0
      ? buildCategoricalHtml(result.categoricalInfo)
      : '';
  }

  const coefBody = $('qb-pro-coef-body');
  if (coefBody) {
    coefBody.innerHTML = (result.coefficients ?? [])
      .map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${fmt(c.estimate)}</td><td>${fmtOpt(c.stdError)}</td><td>${fmtOpt(c.tStat)}</td><td>${fmtOpt(c.pValue)}</td></tr>`)
      .join('');
  }

  const statsBody = $('qb-pro-stats-body');
  if (statsBody) {
    const rows: Array<[string, string]> = [
      ['Forma funcional', result.functionalForm ? FORM_LABELS[result.functionalForm] : '—'],
      ['Observaciones (n)', String(result.nobs ?? '—')],
      ['R²', fmtOpt(result.rSquared)],
      ['R² ajustado', fmtOpt(result.rSquaredAdj)],
      ['F-stat', fmtOpt(result.fStat)],
      ['p-value (F)', fmtOpt(result.fPValue)],
      ['AIC', fmtOpt(result.aic)],
      ['BIC', fmtOpt(result.bic)],
      ['Grados de libertad (residual)', result.dfResid === undefined ? '—' : String(result.dfResid)],
      ['Error estándar residual', fmtOpt(result.residualStdError)],
      ['Inferencia', PRO_STANDARD_ERROR_LABELS[result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE]],
      ['Motor', 'Python / statsmodels (Pyodide en navegador)'],
    ];
    statsBody.innerHTML = rows
      .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join('');
  }

  const seType = result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE;
  const interpretations = interpretProResult(result, 0.05);

  const doctorReport = buildModelDoctor(
    interpretations.map(engineFindingFromInterpretation),
    {
      mode: 'regression',
      engine: 'pro',
      nObs: result.nobs ?? 0,
      droppedRows: 0,
      paramCount: result.coefficients?.length ?? 0,
      hasIntercept: result.coefficients?.some(coefficient => ['const', 'intercept'].includes(coefficient.name.toLowerCase())) ?? true,
      standardErrorType: seType,
      hacMaxLags: result.hacMaxLags ?? null,
      functionalForm: result.functionalForm ?? 'lin-lin',
      hasCategorical: (result.categoricalInfo?.length ?? 0) > 0,
      droppedFeatures: [],
      hasRestriction: Boolean(result.rlsTest),
      binaryTarget: false,
      datasetHasDates: (appState.csvData?.columns?.dateColumns?.size ?? 0) > 0,
      alpha: 0.05,
      rSquared: result.rSquared,
      converged: result.ok,
    }
  );
  const doctorEl = $('qb-pro-model-doctor');
  if (doctorEl) doctorEl.innerHTML = renderModelDoctor(doctorReport);

  const inferenceEl = $('qb-pro-inference');
  if (inferenceEl) {
    inferenceEl.innerHTML = buildInferenceHtml(seType, result.hacMaxLags) +
      renderInterpretationResults(interpretations);
  }

  const rlsTestEl = $('qb-pro-rls-test');
  if (rlsTestEl) {
    rlsTestEl.innerHTML = result.rlsTest ? buildRlsTestHtml(result.rlsTest, seType, comparison?.rlsTest) : '';
  }

  const bpTestEl = $('qb-pro-bp-test');
  if (bpTestEl) {
    bpTestEl.innerHTML = result.breuschPagan ? buildBpTestHtml(result.breuschPagan, seType) : '';
  }

  const warningsEl = $('qb-pro-warnings');
  if (warningsEl) {
    warningsEl.innerHTML = result.warnings.length
      ? `<p class="qb-label" style="margin-top:10px">Advertencias</p>` +
        result.warnings.map(w => `<div class="qb-interp">${escapeHtml(w)}</div>`).join('')
      : '';
  }

  const comparisonEl = $('qb-pro-comparison');
  if (comparisonEl) {
    comparisonEl.innerHTML = comparison ? buildComparisonHtml(result, comparison) : '';
  }

  const content = $('qb-pro-content');
  if (content) content.style.display = '';

  captureCurrentModel(createProModelSnapshot({
    result,
    interpretations,
    doctor: doctorReport,
  }));
}

function buildComparisonHtml(result: PyodideOlsResult, comparison: ProComparison): string {
  if (comparison.designMismatch) {
    return (
      `<p class="qb-label" style="margin-top:10px">Comparación Lite vs Pro</p>` +
      `<div class="qb-interp">${escapeHtml(comparison.designMismatch)}</div>`
    );
  }

  const sections: string[] = [];

  if (comparison.rows.length > 0) {
    const rows = comparison.rows
      .map(row => {
        const diff = Math.abs(row.proEstimate - row.liteEstimate);
        return `<tr><td>${escapeHtml(row.name)}</td><td>${fmt(row.liteEstimate)}</td><td>${fmt(row.proEstimate)}</td><td>${diff.toExponential(2)}</td></tr>`;
      })
      .join('');
    sections.push(`
      <div class="qb-table-scroll">
        <table class="ledger">
          <thead><tr><th>Variable</th><th>Lite (TS)</th><th>Pro (statsmodels)</th><th>|Δ|</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`);
  }

  const metricRows: string[] = [];
  if (comparison.liteRSquared !== null) {
    metricRows.push(`<tr><td>R²</td><td>${fmt(comparison.liteRSquared)}</td><td>${fmtOpt(result.rSquared)}</td></tr>`);
  }
  if (comparison.liteNobs !== null) {
    metricRows.push(`<tr><td>Observaciones (n)</td><td>${comparison.liteNobs}</td><td>${result.nobs ?? '—'}</td></tr>`);
  }
  if (metricRows.length > 0) {
    sections.push(`
      <div class="qb-table-scroll">
        <table class="ledger">
          <thead><tr><th>Métrica</th><th>Lite (TS)</th><th>Pro (statsmodels)</th></tr></thead>
          <tbody>${metricRows.join('')}</tbody>
        </table>
      </div>`);
  }

  if (sections.length === 0) return '';

  // La comparación solo cubre coeficientes, R² y n, que no dependen del tipo de
  // errores estándar. Con Pro robusto se aclara que los SE no son comparables.
  const seType = result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE;
  if (seType !== 'classic') {
    sections.push(
      `<p class="muted qb-help">Lite usa errores estándar clásicos y Pro está usando ${escapeHtml(PRO_STANDARD_ERROR_LABELS[seType])}: ` +
      'los coeficientes, R² y n son comparables; los errores estándar no.</p>'
    );
  }

  const formLabel = result.functionalForm ? FORM_LABELS[result.functionalForm] : '—';
  return (
    `<p class="qb-label" style="margin-top:10px">Comparación Lite vs Pro (${escapeHtml(formLabel)}, coeficientes OLS no restringidos)</p>` +
    sections.join('')
  );
}

function buildCategoricalHtml(info: CategoricalVariableInfo[]): string {
  const variables = info
    .map(
      c => `<p class="qb-interp" style="margin:0 0 4px;font-size:12px">
        <strong>${escapeHtml(c.originalName)}</strong><br>
        Categoría base: <code>${escapeHtml(c.baseCategory)}</code><br>
        Dummies creadas: ${c.createdDummies.map(d => `<code>${escapeHtml(d)}</code>`).join(', ')}
      </p>`
    )
    .join('');
  return `
    <p class="qb-label" style="margin-top:10px">Variables categóricas</p>
    ${variables}
    <p class="muted" style="font-size:11px;margin:2px 0 8px">
      La categoría base se omite para evitar la trampa de dummies. Los coeficientes de las dummies se
      interpretan como diferencias respecto de esa categoría base, manteniendo constantes las demás variables.
    </p>`;
}

function buildInferenceHtml(seType: ProStandardErrorType, hacMaxLags?: number | null): string {
  const info = getProCovarianceInfo(seType, hacMaxLags);
  return `
    <p class="qb-label" style="margin-top:10px">Inferencia: ${escapeHtml(info.label)}</p>
    <div class="qb-interp">${escapeHtml(info.description)}</div>`;
}

// Rβ = q se evalúa con la MISMA covarianza que el resto de la inferencia
// (classic/HC1/HC3/HAC): statsmodels' f_test usa results.cov_params() por debajo,
// que ya respeta cov_type. Por eso el caveat contra Lite (que siempre usa el
// F clásico de rls.ts) depende de qué covarianza esté activa en Pro.
function buildRlsTestHtml(rlsTest: PyodideRlsTest, seType: ProStandardErrorType, comparison?: ProRlsComparison | null): string {
  const verdict = rlsTest.reject ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%';
  const df = `${rlsTest.dfNum ?? '—'}, ${rlsTest.dfDenom ?? '—'}`;
  const covarianceCaveat = seType === 'classic'
    ? 'El test de restricción usa errores estándar clásicos y debería coincidir con el F clásico de Lite salvo diferencias numéricas mínimas.'
    : `El test de restricción en Pro usa la matriz de covarianza robusta seleccionada (${escapeHtml(PRO_STANDARD_ERROR_LABELS[seType])}). Por eso puede diferir del F clásico de Lite.`;

  let table = '';
  if (comparison) {
    table = `
      <div class="qb-table-scroll" style="margin-top:6px">
        <table class="ledger">
          <thead><tr><th></th><th>Lite (RSS restringido vs no restringido)</th><th>Pro (statsmodels f_test)</th></tr></thead>
          <tbody>
            <tr><td>F-stat</td><td>${fmtOpt(comparison.liteFStat)}</td><td>${fmtOpt(rlsTest.fStat)}</td></tr>
            <tr><td>p-value</td><td>${fmtOpt(comparison.litePValue)}</td><td>${fmtOpt(rlsTest.fPValue)}</td></tr>
          </tbody>
        </table>
      </div>`;
  }

  return `
    <p class="qb-label" style="margin-top:10px">Test de restricción (Wald/F, statsmodels)</p>
    <div class="qb-interp">
      H0: ${escapeHtml(rlsTest.label)}<br>
      F = ${fmtOpt(rlsTest.fStat)} (df = ${escapeHtml(df)}) · p-value = ${fmtOpt(rlsTest.fPValue)}<br>
      <strong>${verdict}</strong><br>
      <span class="muted" style="font-size:11px">
        Este test no re-estima los coeficientes bajo la restricción — sólo evalúa si Rβ = q es compatible con los datos.
        Los coeficientes de la tabla de arriba son siempre el OLS no restringido.<br>
        ${covarianceCaveat}
      </span>
    </div>${table}`;
}

// "Probá HC3" sólo tiene sentido si todavía no estás en HC3 (evitar una
// recomendación redundante) — HC1 también podría "subir" a HC3, pero el
// pedido explícito acá es no repetir la sugerencia únicamente cuando ya se
// está en HC3.
function buildBpTestHtml(bp: PyodideBreuschPagan, seType: ProStandardErrorType): string {
  const recommendation =
    seType === 'classic' && bp.rejectAt5
      ? `<p class="muted qb-help" style="margin-top:8px">
          El test Breusch-Pagan sugiere heterocedasticidad. Los errores estándar clásicos pueden ser poco confiables.
          Probá HC3 para inferencia más robusta.
        </p>`
      : '';

  return `
    <p class="qb-label" style="margin-top:10px">Test Breusch-Pagan</p>
    <div class="qb-interp">
      H0: varianza constante de los errores (homocedasticidad)<br>
      LM-statistic: ${fmt(bp.lmStatistic)} · p-value: ${fmt(bp.lmPValue)}<br>
      F-statistic: ${fmt(bp.fStatistic)} · p-value: ${fmt(bp.fPValue)}<br>
      <strong>Conclusión: ${escapeHtml(bp.interpretation)}</strong>
    </div>${recommendation}`;
}
