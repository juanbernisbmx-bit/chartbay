import type { ParsedCSV } from '../csvParser';
import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import {
  DEFAULT_ARIMA_ORDER,
  DEFAULT_FORECAST_STEPS,
  DEFAULT_PRO_ADF_REGRESSION,
  PRO_ADF_REGRESSION_LABELS,
  isProAdfRegression,
  type ProAcfPoint,
  type ProAdfRegression,
  type ProAdfResult,
  type ProArimaForecast,
  type ProArimaOrder,
  type ProArimaResidualDiagnostics,
  type ProArimaResult,
  type ProLjungBoxRow,
  type PyodideTimeSeriesResult,
} from '../pro/pyodide/proTimeSeriesResultTypes';

// Chart.js se carga globalmente por CDN en quantbay.html (igual que en el motor
// Lite, ver ui/timeseriesView.ts). No es un import npm — se accede por el global
// y todo acceso se protege con `typeof Chart === 'undefined'`.
declare const Chart: any;

// Ventana de observados a mostrar en el gráfico de forecast (los últimos N).
const OBSERVED_WINDOW = 30;

// Nota pedagógica fija que acompaña siempre a los diagnósticos.
const PEDAGOGICAL_NOTE =
  'ADF evalúa estacionariedad. ACF/PACF ayudan a identificar rezagos candidatos para modelos AR, MA o ARIMA. ' +
  'Ljung-Box evalúa autocorrelación conjunta.';

// UX honesta: ARIMA manual + forecast básico están; auto-ARIMA no.
const ARIMA_STATUS_NOTE =
  'ARIMA Pro permite estimar modelos manuales y generar forecast básico. La selección automática de modelo ' +
  '(auto-ARIMA) todavía no está implementada.';

// Nota pedagógica sobre criterios de información para comparar modelos.
const ARIMA_IC_NOTE =
  'AIC y BIC sirven para comparar modelos estimados sobre la misma serie. Valores menores suelen indicar mejor ' +
  'balance entre ajuste y complejidad.';

// Nota pedagógica del forecast.
const FORECAST_NOTE =
  'El forecast proyecta valores futuros a partir del modelo ARIMA estimado. Los intervalos reflejan incertidumbre ' +
  'del pronóstico y suelen ampliarse a medida que crece el horizonte. El forecast no es una promesa: es una ' +
  'proyección condicionada al patrón histórico y al modelo elegido.';

// Notas del gráfico de forecast.
const FORECAST_CHART_NOTE =
  'El gráfico muestra los últimos valores observados y el pronóstico ARIMA. Las bandas representan incertidumbre ' +
  'del forecast cuando statsmodels las devuelve.';
const FORECAST_CHART_NO_INTERVALS =
  'Statsmodels no devolvió intervalos completos para este forecast. Se muestra solo el pronóstico medio.';
const FORECAST_CHART_NO_LIB =
  'No se pudo renderizar el gráfico porque la librería de gráficos no está disponible.';

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

export function getProArimaEnabled(): boolean {
  const checkbox = $('qb-pro-ts-arima-enable') as HTMLInputElement | null;
  return checkbox?.checked ?? false;
}

// Lee p, d, q de los inputs. Un campo vacío/no entero cae al default sugerido;
// los límites y la coherencia (no negativos, no todos cero) se validan en
// proTimeSeriesValidation.ts antes de correr Pyodide.
export function getProArimaOrder(): ProArimaOrder {
  const read = (id: string, fallback: number): number => {
    const raw = ($(id) as HTMLInputElement | null)?.value?.trim() ?? '';
    if (raw === '') return fallback;
    const parsed = Number(raw);
    return Number.isInteger(parsed) ? parsed : fallback;
  };
  return {
    p: read('qb-pro-ts-arima-p', DEFAULT_ARIMA_ORDER.p),
    d: read('qb-pro-ts-arima-d', DEFAULT_ARIMA_ORDER.d),
    q: read('qb-pro-ts-arima-q', DEFAULT_ARIMA_ORDER.q),
  };
}

// Horizonte de forecast. Campo vacío/no entero → default (12); los límites
// (1..60) se validan en proTimeSeriesValidation.ts antes de correr Pyodide.
export function getProForecastSteps(defaultValue = DEFAULT_FORECAST_STEPS): number {
  const raw = ($('qb-pro-ts-forecast-steps') as HTMLInputElement | null)?.value?.trim() ?? '';
  if (raw === '') return defaultValue;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : defaultValue;
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
  for (const id of ['qb-pro-ts-adf', 'qb-pro-ts-acfpacf', 'qb-pro-ts-ljungbox', 'qb-pro-ts-arima-section', 'qb-pro-ts-warnings']) {
    const el = $(id);
    if (el) el.innerHTML = '';
  }
  const note = $('qb-pro-ts-note');
  if (note) note.textContent = '';
  const arima = $('qb-pro-ts-arima-note');
  if (arima) arima.textContent = '';
  // El gráfico de forecast se destruye y su sección se oculta al limpiar, para
  // no dejar un chart viejo colgado entre corridas.
  destroyProForecastChart();
  const chartSection = $('qb-pro-ts-forecast-chart-section');
  if (chartSection) chartSection.style.display = 'none';
  const chartNote = $('qb-pro-ts-forecast-chart-note');
  if (chartNote) chartNote.textContent = '';
  const chartStatus = $('qb-pro-ts-forecast-chart-status');
  if (chartStatus) chartStatus.textContent = '';
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

function orderLabel(order: ProArimaOrder): string {
  return `ARIMA(${order.p},${order.d},${order.q})`;
}

function buildArimaResidualHtml(diag: ProArimaResidualDiagnostics | undefined): string {
  if (!diag || diag.ljungBox.length === 0) return '';
  const body = diag.ljungBox
    .map(row => {
      const verdict = row.rejectAt5 ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%';
      return `<tr><td>${row.lag}</td><td>${fmt(row.statistic)}</td><td>${fmt(row.pValue)}</td><td>${escapeHtml(verdict)}</td></tr>`;
    })
    .join('');
  return `
    <p class="qb-label" style="margin-top:10px">Diagnóstico de residuos (Ljung-Box)</p>
    <div class="qb-table-scroll">
      <table class="ledger">
        <thead><tr><th>Lag</th><th>Q-stat</th><th>p-value</th><th>Conclusión</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
    <div class="qb-interp" style="margin-top:8px">${escapeHtml(diag.interpretation)}</div>`;
}

// Forecast del ARIMA: error controlado (el ARIMA sigue mostrándose), o tabla de
// pronósticos con intervalos + nota pedagógica. '' cuando no se pidió forecast.
function buildForecastHtml(arima: ProArimaResult): string {
  if (arima.forecastError) {
    return (
      `<p class="qb-label" style="margin-top:10px">Forecast ARIMA</p>` +
      `<div class="qb-interp" style="color:#e55">${escapeHtml(arima.forecastError)}</div>`
    );
  }

  const forecast: ProArimaForecast | undefined = arima.forecast;
  if (!forecast || forecast.items.length === 0) return '';

  const rows = forecast.items
    .map(
      item =>
        `<tr><td>t+${item.step}</td><td>${fmt(item.mean)}</td><td>${fmt(item.lower)}</td><td>${fmt(item.upper)}</td></tr>`
    )
    .join('');
  const confidencePct = Math.round(forecast.confidenceLevel * 100);
  const forecastWarnings = forecast.warnings.length > 0
    ? `<div class="qb-warn-yellow" style="margin-top:6px"><ul>${forecast.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
    : '';

  return `
    <p class="qb-label" style="margin-top:10px">Forecast ARIMA (${forecast.steps} períodos, intervalos al ${confidencePct}%)</p>
    <div class="qb-table-scroll">
      <table class="ledger">
        <thead><tr><th>Paso</th><th>Pronóstico</th><th>Límite inferior</th><th>Límite superior</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${forecastWarnings}
    <div class="qb-interp" style="margin-top:8px">${escapeHtml(FORECAST_NOTE)}</div>`;
}

// Sección ARIMA completa: error controlado, o resumen + coeficientes + warnings
// + diagnóstico de residuos. Devuelve '' cuando no se pidió ARIMA.
function buildArimaHtml(result: PyodideTimeSeriesResult): string {
  if (result.arimaError) {
    return (
      `<p class="qb-label" style="margin-top:10px">ARIMA</p>` +
      `<div class="qb-interp" style="color:#e55">${escapeHtml(result.arimaError)}</div>` +
      `<div class="qb-interp" style="margin-top:6px">Revisá los valores de p, d y q, o probá un orden más simple.</div>`
    );
  }

  const arima = result.arima;
  if (!arima) return '';

  const converged =
    arima.converged === true ? 'Sí' : arima.converged === false ? 'No' : 'No informada';

  const summary = `
    <table class="ledger">
      <thead><tr><th>ARIMA</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td>Modelo estimado</td><td>${escapeHtml(orderLabel(arima.order))}</td></tr>
        <tr><td>Observaciones usadas</td><td>${arima.nobs ?? '—'}</td></tr>
        <tr><td>Convergencia</td><td>${escapeHtml(converged)}</td></tr>
        <tr><td>Log-likelihood</td><td>${fmt(arima.logLikelihood)}</td></tr>
        <tr><td>AIC</td><td>${fmt(arima.aic)}</td></tr>
        <tr><td>BIC</td><td>${fmt(arima.bic)}</td></tr>
        <tr><td>HQIC</td><td>${fmt(arima.hqic)}</td></tr>
      </tbody>
    </table>`;

  const coefRows = arima.coefficients
    .map(
      c =>
        `<tr><td>${escapeHtml(c.name)}</td><td>${fmt(c.estimate)}</td><td>${fmt(c.standardError)}</td><td>${fmt(c.zStatistic)}</td><td>${fmt(c.pValue)}</td></tr>`
    )
    .join('');
  const coefTable = arima.coefficients.length > 0
    ? `
      <p class="qb-label" style="margin-top:10px">Coeficientes</p>
      <div class="qb-table-scroll">
        <table class="ledger">
          <thead><tr><th>Parámetro</th><th>Estimación</th><th>Error estándar</th><th>z-stat</th><th>p-value</th></tr></thead>
          <tbody>${coefRows}</tbody>
        </table>
      </div>`
    : '';

  const modelWarnings = arima.warnings.length > 0
    ? `<p class="qb-label" style="margin-top:10px">Advertencias del modelo</p>` +
      `<div class="qb-warn-yellow"><ul>${arima.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
    : '';

  return (
    `<p class="qb-label" style="margin-top:10px">${escapeHtml(orderLabel(arima.order))}</p>` +
    `<div class="qb-interp" style="margin-bottom:6px">${escapeHtml(arima.interpretation)}</div>` +
    summary +
    coefTable +
    modelWarnings +
    buildArimaResidualHtml(result.arimaResidualDiagnostics) +
    buildForecastHtml(arima) +
    `<div class="qb-interp" style="margin-top:8px">${escapeHtml(ARIMA_IC_NOTE)}</div>`
  );
}

// ── Gráfico de forecast (Chart.js) ───────────────────────────────────────────
// Instancia única a nivel de módulo (igual que el chart Lite): se destruye
// SIEMPRE antes de crear otra, para no duplicar charts al recalcular.
let proForecastChart: unknown = null;

export function destroyProForecastChart(): void {
  if (proForecastChart) {
    try {
      (proForecastChart as { destroy(): void }).destroy();
    } catch {
      // Un destroy fallido no debe romper el resto del render.
    }
    proForecastChart = null;
  }
}

function forecastChartLabel(offsetFromLastObserved: number): string {
  // 0 = último observado ("t"), negativos hacia atrás ("t-1"...), positivos futuros ("t+1"...).
  if (offsetFromLastObserved === 0) return 't';
  return offsetFromLastObserved < 0 ? `t${offsetFromLastObserved}` : `t+${offsetFromLastObserved}`;
}

/**
 * Renderiza el gráfico de forecast: últimos observados + pronóstico medio +
 * banda inferior/superior (si statsmodels devolvió intervalos completos).
 * - Sólo se dibuja si hay un forecast válido; si no, se oculta la sección.
 * - NUNCA inventa bandas: con algún lower/upper null, muestra sólo la media.
 * - Si Chart.js no está disponible, no rompe: muestra un mensaje controlado.
 */
function renderProForecastChart(observedValues: number[] | undefined, forecast: ProArimaForecast | undefined): void {
  // Destruir el chart previo antes que nada: recalcular nunca deja dos.
  destroyProForecastChart();

  const section = $('qb-pro-ts-forecast-chart-section');
  const noteEl = $('qb-pro-ts-forecast-chart-note');
  const statusEl = $('qb-pro-ts-forecast-chart-status');

  const hasForecast = !!forecast && forecast.items.length > 0;
  if (!hasForecast) {
    if (section) section.style.display = 'none';
    if (noteEl) noteEl.textContent = '';
    if (statusEl) statusEl.textContent = '';
    return;
  }

  if (section) section.style.display = '';
  // La nota pedagógica se muestra tenga o no Chart.js disponible.
  if (noteEl) noteEl.textContent = FORECAST_CHART_NOTE;

  // Chart.js ausente: mensaje controlado, sin romper la tabla ni el resto.
  if (typeof Chart === 'undefined') {
    if (statusEl) statusEl.textContent = FORECAST_CHART_NO_LIB;
    return;
  }

  const canvas = $('qb-pro-arima-forecast-chart') as HTMLCanvasElement | null;
  if (!canvas) return;

  const observed = (observedValues ?? []).filter(v => typeof v === 'number' && Number.isFinite(v));
  const k = Math.min(OBSERVED_WINDOW, observed.length);
  const observedTail = observed.slice(observed.length - k);
  const items = forecast!.items;
  const h = items.length;
  const total = k + h;
  // No se inventan bandas: sólo se dibujan si TODO lower/upper es finito.
  const hasIntervals = items.every(it => it.lower !== null && it.upper !== null);

  const labels: string[] = [];
  for (let i = 0; i < k; i += 1) labels.push(forecastChartLabel(-(k - 1 - i)));
  for (const item of items) labels.push(`t+${item.step}`);

  const observedData: Array<number | null> = new Array(total).fill(null);
  for (let i = 0; i < k; i += 1) observedData[i] = observedTail[i];

  // El forecast (media y bandas) se ancla al último observado para que la línea
  // conecte historia con futuro en vez de "flotar".
  const anchor = k > 0 ? observedTail[k - 1] : null;
  const meanData: Array<number | null> = new Array(total).fill(null);
  if (k > 0) meanData[k - 1] = anchor;
  for (let i = 0; i < h; i += 1) meanData[k + i] = items[i].mean;

  const datasets: unknown[] = [
    {
      label: 'Observado',
      data: observedData,
      borderColor: '#1b3a6b',
      backgroundColor: 'rgba(27,58,107,.10)',
      pointRadius: 2,
      tension: 0.15,
      spanGaps: false,
    },
  ];

  if (hasIntervals) {
    const lowerData: Array<number | null> = new Array(total).fill(null);
    const upperData: Array<number | null> = new Array(total).fill(null);
    if (k > 0) { lowerData[k - 1] = anchor; upperData[k - 1] = anchor; }
    for (let i = 0; i < h; i += 1) {
      lowerData[k + i] = items[i].lower;
      upperData[k + i] = items[i].upper;
    }
    // La banda se pinta rellenando el 'superior' hasta el dataset anterior
    // ('inferior', índice -1 en el arreglo de datasets).
    datasets.push({
      label: 'Límite inferior',
      data: lowerData,
      borderColor: 'rgba(200,120,0,.45)',
      borderDash: [4, 4],
      pointRadius: 0,
      fill: false,
      tension: 0.1,
    });
    datasets.push({
      label: 'Límite superior',
      data: upperData,
      borderColor: 'rgba(200,120,0,.45)',
      borderDash: [4, 4],
      pointRadius: 0,
      fill: '-1',
      backgroundColor: 'rgba(230,160,50,.15)',
      tension: 0.1,
    });
  }

  // La media va última para dibujarse por encima de la banda.
  datasets.push({
    label: 'Forecast',
    data: meanData,
    borderColor: '#c8780a',
    borderDash: [6, 3],
    pointRadius: 2,
    tension: 0.1,
  });

  proForecastChart = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: true } },
      scales: {
        x: { ticks: { maxRotation: 0, autoSkip: true } },
        y: { beginAtZero: false },
      },
    },
  });

  if (statusEl) statusEl.textContent = hasIntervals ? '' : FORECAST_CHART_NO_INTERVALS;
}

export function renderProTimeSeriesResult(result: PyodideTimeSeriesResult, observedValues?: number[]): void {
  const panel = $('qb-pro-ts-panel');
  if (panel) panel.style.display = '';
  showProTimeSeriesStatus('');

  if (!result.ok) {
    showProTimeSeriesError(result.error ?? 'Error desconocido en el motor Pro de series de tiempo.');
    destroyProForecastChart();
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

  // La sección ARIMA es independiente de los diagnósticos: si ARIMA falla o no
  // se pidió, los diagnósticos de arriba siguen renderizados igual.
  const arimaSection = $('qb-pro-ts-arima-section');
  if (arimaSection) arimaSection.innerHTML = buildArimaHtml(result);

  // El gráfico de forecast se dibuja sólo si hay forecast válido; nunca rompe
  // la tabla de forecast ni el resto del panel.
  renderProForecastChart(observedValues, result.arima?.forecast);

  const note = $('qb-pro-ts-note');
  if (note) note.textContent = PEDAGOGICAL_NOTE;

  const arima = $('qb-pro-ts-arima-note');
  if (arima) arima.textContent = ARIMA_STATUS_NOTE;

  const warningsEl = $('qb-pro-ts-warnings');
  if (warningsEl) {
    warningsEl.innerHTML = result.warnings.length > 0
      ? `<div class="qb-warn-yellow"><ul>${result.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`
      : '';
  }

  const content = $('qb-pro-ts-content');
  if (content) content.style.display = '';
}
