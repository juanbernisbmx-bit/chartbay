import type { ParsedCSV } from '../csvParser';
import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import {
  DEFAULT_PRO_ADF_REGRESSION,
  PRO_ADF_REGRESSION_LABELS,
  isProAdfRegression,
  type ProAcfPoint,
  type ProAdfRegression,
  type ProAdfResult,
  type ProLjungBoxRow,
  type PyodideTimeSeriesResult,
} from '../pro/pyodide/proTimeSeriesResultTypes';

// Nota pedagógica fija que acompaña siempre a los diagnósticos.
const PEDAGOGICAL_NOTE =
  'ADF evalúa estacionariedad. ACF/PACF ayudan a identificar rezagos candidatos para modelos AR, MA o ARIMA. ' +
  'Ljung-Box evalúa autocorrelación conjunta.';

// UX honesta: ARIMA todavía no está implementado. Nunca se finge un resultado.
const ARIMA_NOT_IMPLEMENTED_NOTE =
  'ARIMA todavía no está implementado en Pro. Primero usá ADF, ACF/PACF y Ljung-Box para diagnosticar la serie.';

const DEFAULT_MAX_LAG = 12;

function isFiniteNumeric(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  return Number.isFinite(Number(value));
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1e6 ? value.toExponential(4) : value.toFixed(6);
}

function optionHtml(value: string): string {
  return `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
}

// Columnas candidatas a serie: las que tienen al menos un valor numérico finito.
export function getProTimeSeriesValueColumns(rows: Record<string, unknown>[], headers: string[]): string[] {
  return headers.filter(header => rows.some(row => isFiniteNumeric(row[header])));
}

export function getSelectedProTimeSeriesValueColumn(): string {
  const select = $('qb-pro-ts-value') as HTMLSelectElement | null;
  return select?.value ?? '';
}

export function getProTimeSeriesMaxLag(defaultValue = DEFAULT_MAX_LAG): number {
  const input = $('qb-pro-ts-maxlag') as HTMLInputElement | null;
  // Un campo vacío usa el default (Number('') === 0 sería engañoso).
  const raw = input?.value?.trim() ?? '';
  if (raw === '') return defaultValue;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : defaultValue;
}

export function getProTimeSeriesAdfRegression(): ProAdfRegression {
  const select = $('qb-pro-ts-adf-reg') as HTMLSelectElement | null;
  const value = select?.value;
  return isProAdfRegression(value) ? value : DEFAULT_PRO_ADF_REGRESSION;
}

export function showProTimeSeriesStatus(text: string): void {
  const el = $('qb-pro-ts-status');
  if (!el) return;
  el.textContent = text;
  el.style.display = text ? '' : 'none';
}

export function renderProTimeSeriesNoData(
  message = 'Subí un CSV para diagnosticar una serie de tiempo con statsmodels.'
): void {
  const panel = $('qb-pro-ts-panel');
  const empty = $('qb-pro-ts-empty');
  const controls = $('qb-pro-ts-controls');
  if (panel) panel.style.display = '';
  if (empty) {
    empty.textContent = message;
    empty.style.display = '';
  }
  if (controls) controls.style.display = 'none';
  clearProTimeSeriesResult();
}

export function renderProTimeSeriesSelectors(data: ParsedCSV, selectedValueColumn?: string): void {
  const empty = $('qb-pro-ts-empty');
  const controls = $('qb-pro-ts-controls');
  const valueSelect = $('qb-pro-ts-value') as HTMLSelectElement | null;
  const runButton = $('qb-pro-ts-run') as HTMLButtonElement | null;

  const valueColumns = getProTimeSeriesValueColumns(data.rows, data.headers);
  if (valueColumns.length === 0) {
    renderProTimeSeriesNoData('No se detectó una columna numérica para analizar como serie de tiempo.');
    return;
  }

  const valueColumn =
    selectedValueColumn && valueColumns.includes(selectedValueColumn) ? selectedValueColumn : valueColumns[0];

  if (empty) empty.style.display = 'none';
  if (controls) controls.style.display = '';
  if (valueSelect) {
    valueSelect.innerHTML = valueColumns.map(optionHtml).join('');
    valueSelect.value = valueColumn;
  }
  if (runButton) runButton.disabled = !valueColumn;
  clearProTimeSeriesResult();
}

/**
 * Limpia cualquier resultado Pro de series previo para que no queden tablas ni
 * conclusiones viejas visibles mientras carga o corre un nuevo diagnóstico.
 */
export function clearProTimeSeriesResult(): void {
  const content = $('qb-pro-ts-content');
  if (content) content.style.display = 'none';
  const error = $('qb-pro-ts-error');
  if (error) { error.textContent = ''; error.style.display = 'none'; }
  for (const id of ['qb-pro-ts-adf', 'qb-pro-ts-acfpacf', 'qb-pro-ts-ljungbox', 'qb-pro-ts-warnings']) {
    const el = $(id);
    if (el) el.innerHTML = '';
  }
  const note = $('qb-pro-ts-note');
  if (note) note.textContent = '';
  const arima = $('qb-pro-ts-arima-note');
  if (arima) arima.textContent = '';
}

export function resetProTimeSeriesView(): void {
  clearProTimeSeriesResult();
  showProTimeSeriesStatus('');
}

function showProTimeSeriesError(message: string): void {
  const error = $('qb-pro-ts-error');
  if (error) {
    error.innerHTML = escapeHtml(message).replace(/\n/g, '<br>');
    error.style.display = '';
  }
  const content = $('qb-pro-ts-content');
  if (content) content.style.display = 'none';
}

function buildAdfHtml(adf: ProAdfResult | undefined): string {
  if (!adf) {
    return '<div class="qb-interp">ADF no disponible para esta serie.</div>';
  }
  const critEntries = Object.entries(adf.criticalValues);
  const crit = critEntries.length > 0
    ? critEntries.map(([k, v]) => `${escapeHtml(k)} ${fmt(v)}`).join(', ')
    : '—';
  const verdict = adf.rejectAt5 ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%';
  return `
    <table class="ledger">
      <thead><tr><th>ADF test</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td>H0</td><td>la serie tiene raíz unitaria (no es estacionaria)</td></tr>
        <tr><td>Estadístico</td><td>${fmt(adf.statistic)}</td></tr>
        <tr><td>p-value</td><td>${fmt(adf.pValue)}</td></tr>
        <tr><td>Rezagos usados</td><td>${adf.usedLag}</td></tr>
        <tr><td>n usado</td><td>${adf.nobs}</td></tr>
        <tr><td>Valores críticos</td><td>${crit}</td></tr>
        <tr><td>Conclusión</td><td>${escapeHtml(verdict)}</td></tr>
      </tbody>
    </table>
    <div class="qb-interp" style="margin-top:8px">${escapeHtml(adf.interpretation)}</div>`;
}

function buildAcfPacfHtml(acf: ProAcfPoint[] | undefined, pacf: ProAcfPoint[] | undefined): string {
  const acfByLag = new Map<number, number>();
  for (const point of acf ?? []) acfByLag.set(point.lag, point.value);
  const pacfByLag = new Map<number, number>();
  for (const point of pacf ?? []) pacfByLag.set(point.lag, point.value);

  const lags = Array.from(new Set([...acfByLag.keys(), ...pacfByLag.keys()])).sort((a, b) => a - b);
  if (lags.length === 0) {
    return '<div class="qb-interp">ACF/PACF no disponibles para esta serie.</div>';
  }

  const rows = lags
    .map(lag => {
      const acfVal = acfByLag.has(lag) ? fmt(acfByLag.get(lag)) : '—';
      const pacfVal = pacfByLag.has(lag) ? fmt(pacfByLag.get(lag)) : '—';
      return `<tr><td>${lag}</td><td>${acfVal}</td><td>${pacfVal}</td></tr>`;
    })
    .join('');
  return `
    <table class="ledger">
      <thead><tr><th>Lag</th><th>ACF</th><th>PACF</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildLjungBoxHtml(rows: ProLjungBoxRow[] | undefined): string {
  if (!rows || rows.length === 0) {
    return '<div class="qb-interp">Ljung-Box no disponible para los rezagos seleccionados.</div>';
  }
  const body = rows
    .map(row => {
      const verdict = row.rejectAt5 ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%';
      return `<tr><td>${row.lag}</td><td>${fmt(row.statistic)}</td><td>${fmt(row.pValue)}</td><td>${escapeHtml(verdict)}</td></tr>`;
    })
    .join('');
  return `
    <table class="ledger">
      <thead><tr><th>Lag</th><th>Q-stat</th><th>p-value</th><th>Conclusión</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div class="qb-interp" style="margin-top:8px">H0: no hay autocorrelación conjunta hasta ese rezago.</div>`;
}

export function renderProTimeSeriesResult(result: PyodideTimeSeriesResult): void {
  const panel = $('qb-pro-ts-panel');
  if (panel) panel.style.display = '';
  showProTimeSeriesStatus('');

  if (!result.ok) {
    showProTimeSeriesError(result.error ?? 'Error desconocido en el motor Pro de series de tiempo.');
    return;
  }

  const error = $('qb-pro-ts-error');
  if (error) { error.textContent = ''; error.style.display = 'none'; }

  const adfEl = $('qb-pro-ts-adf');
  if (adfEl) adfEl.innerHTML = buildAdfHtml(result.adf);

  const acfPacfEl = $('qb-pro-ts-acfpacf');
  if (acfPacfEl) acfPacfEl.innerHTML = buildAcfPacfHtml(result.acf, result.pacf);

  const ljungBoxEl = $('qb-pro-ts-ljungbox');
  if (ljungBoxEl) ljungBoxEl.innerHTML = buildLjungBoxHtml(result.ljungBox);

  const note = $('qb-pro-ts-note');
  if (note) note.textContent = PEDAGOGICAL_NOTE;

  const arima = $('qb-pro-ts-arima-note');
  if (arima) arima.textContent = ARIMA_NOT_IMPLEMENTED_NOTE;

  const warningsEl = $('qb-pro-ts-warnings');
  if (warningsEl) {
    warningsEl.innerHTML = result.warnings.length > 0
      ? `<div class="qb-warn-yellow"><ul>${result.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
      : '';
  }

  const content = $('qb-pro-ts-content');
  if (content) content.style.display = '';
}
