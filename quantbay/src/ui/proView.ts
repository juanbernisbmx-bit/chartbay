import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import {
  DEFAULT_PRO_STANDARD_ERROR_TYPE,
  PRO_STANDARD_ERROR_LABELS,
  type PyodideOlsResult,
} from '../pro/pyodide/proResultTypes';

export type ProComparisonRow = {
  name: string;
  liteEstimate: number;
  proEstimate: number;
};

export type ProComparison = {
  rows: ProComparisonRow[];
  liteRSquared: number | null;
  liteNobs: number | null;
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

export function hideProPanel(): void {
  const panel = $('qb-pro-results');
  if (panel) panel.style.display = 'none';
  showProStatus('');
  const error = $('qb-pro-error');
  if (error) { error.textContent = ''; error.style.display = 'none'; }
  const content = $('qb-pro-content');
  if (content) content.style.display = 'none';
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
  const warningsEl = $('qb-pro-warnings');
  if (warningsEl) warningsEl.innerHTML = '';
  const comparisonEl = $('qb-pro-comparison');
  if (comparisonEl) comparisonEl.innerHTML = '';
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
    return;
  }

  const error = $('qb-pro-error');
  if (error) { error.textContent = ''; error.style.display = 'none'; }

  const coefBody = $('qb-pro-coef-body');
  if (coefBody) {
    coefBody.innerHTML = (result.coefficients ?? [])
      .map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${fmt(c.estimate)}</td><td>${fmtOpt(c.stdError)}</td><td>${fmtOpt(c.tStat)}</td><td>${fmtOpt(c.pValue)}</td></tr>`)
      .join('');
  }

  const statsBody = $('qb-pro-stats-body');
  if (statsBody) {
    const rows: Array<[string, string]> = [
      ['Observaciones (n)', String(result.nobs ?? '—')],
      ['R²', fmtOpt(result.rSquared)],
      ['R² ajustado', fmtOpt(result.rSquaredAdj)],
      ['F-stat', fmtOpt(result.fStat)],
      ['p-value (F)', fmtOpt(result.fPValue)],
      ['Grados de libertad (residual)', result.dfResid === undefined ? '—' : String(result.dfResid)],
      ['Error estándar residual', fmtOpt(result.residualStdError)],
      ['Inferencia', PRO_STANDARD_ERROR_LABELS[result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE]],
      ['Motor', 'Python / statsmodels (Pyodide en navegador)'],
    ];
    statsBody.innerHTML = rows
      .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join('');
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
}

function buildComparisonHtml(result: PyodideOlsResult, comparison: ProComparison): string {
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

  return `<p class="qb-label" style="margin-top:10px">Comparación Lite vs Pro (lin-lin, sin restricción)</p>${sections.join('')}`;
}
