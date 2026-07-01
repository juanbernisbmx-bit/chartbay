import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import type { PyodideOlsResult } from '../pro/pyodide/proResultTypes';

export type ProComparisonRow = {
  name: string;
  liteEstimate: number;
  proEstimate: number;
};

const fmt = (value: number): string => (Number.isFinite(value) ? value.toFixed(6) : '—');

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

export function renderProResult(result: PyodideOlsResult, comparison?: ProComparisonRow[] | null): void {
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
      .map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${fmt(c.estimate)}</td></tr>`)
      .join('');
  }

  const statsBody = $('qb-pro-stats-body');
  if (statsBody) {
    const rows: Array<[string, string]> = [
      ['Observaciones (n)', String(result.nobs ?? '—')],
      ['R²', result.rSquared === undefined ? '—' : fmt(result.rSquared)],
      ['Error estándar residual', result.residualStdError === undefined ? '—' : fmt(result.residualStdError)],
      ['Motor', 'Python / Pyodide (navegador)'],
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
    if (comparison && comparison.length > 0) {
      const rows = comparison
        .map(row => {
          const diff = Math.abs(row.proEstimate - row.liteEstimate);
          return `<tr><td>${escapeHtml(row.name)}</td><td>${fmt(row.liteEstimate)}</td><td>${fmt(row.proEstimate)}</td><td>${diff.toExponential(2)}</td></tr>`;
        })
        .join('');
      comparisonEl.innerHTML = `
        <p class="qb-label" style="margin-top:10px">Comparación Lite vs Pro (lin-lin, sin restricción)</p>
        <div class="qb-table-scroll">
          <table class="ledger">
            <thead><tr><th>Variable</th><th>Lite (TS)</th><th>Pro (Python)</th><th>|Δ|</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    } else {
      comparisonEl.innerHTML = '';
    }
  }

  const content = $('qb-pro-content');
  if (content) content.style.display = '';
}
