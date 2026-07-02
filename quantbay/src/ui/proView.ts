import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import type { PyodideOlsResult, PyodideRlsTest } from '../pro/pyodide/proResultTypes';
import { FORM_LABELS } from './formRecommendView';

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
      ['Forma funcional', result.functionalForm ? FORM_LABELS[result.functionalForm] : '—'],
      ['Observaciones (n)', String(result.nobs ?? '—')],
      ['R²', fmtOpt(result.rSquared)],
      ['R² ajustado', fmtOpt(result.rSquaredAdj)],
      ['F-stat', fmtOpt(result.fStat)],
      ['p-value (F)', fmtOpt(result.fPValue)],
      ['Grados de libertad (residual)', result.dfResid === undefined ? '—' : String(result.dfResid)],
      ['Error estándar residual', fmtOpt(result.residualStdError)],
      ['Motor', 'Python / statsmodels (Pyodide en navegador)'],
    ];
    statsBody.innerHTML = rows
      .map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)
      .join('');
  }

  const rlsTestEl = $('qb-pro-rls-test');
  if (rlsTestEl) {
    rlsTestEl.innerHTML = result.rlsTest ? buildRlsTestHtml(result.rlsTest, comparison?.rlsTest) : '';
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
  const formLabel = result.functionalForm ? FORM_LABELS[result.functionalForm] : '—';
  return (
    `<p class="qb-label" style="margin-top:10px">Comparación Lite vs Pro (${escapeHtml(formLabel)}, coeficientes OLS no restringidos)</p>` +
    sections.join('')
  );
}

function buildRlsTestHtml(rlsTest: PyodideRlsTest, comparison?: ProRlsComparison | null): string {
  const verdict = rlsTest.reject ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%';
  const df = `${rlsTest.dfNum ?? '—'}, ${rlsTest.dfDenom ?? '—'}`;

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
        Los coeficientes de la tabla de arriba son siempre el OLS no restringido.
      </span>
    </div>${table}`;
}
