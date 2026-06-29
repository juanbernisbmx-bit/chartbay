import type { ParsedCSV } from '../csvParser';
import type {
  TimeSeriesACFDiagnostics,
  TimeSeriesAnalysisResult,
  TimeSeriesSummary,
  TimeSeriesTransformationKey,
  TimeSeriesTransformedSeries,
  TimeSeriesValidationIssue,
} from '../timeseries/types';
import { detectDateColumn } from '../timeseries/validation';
import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';

declare const Chart: any;

let timeSeriesChart: any = null;
let pendingTimeSeriesChartFrame: { id: number; type: 'animationFrame' | 'timeout' } | null = null;

function isFiniteNumeric(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric);
}

function formatDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : 'N/D';
}

function formatNumber(value: number | null): string {
  return value === null ? 'N/D' : value.toFixed(6);
}

function optionHtml(value: string): string {
  return `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`;
}

export function getTimeSeriesValueColumns(
  rows: Record<string, unknown>[],
  headers: string[],
  dateColumn: string | null
): string[] {
  return headers.filter(header =>
    header !== dateColumn &&
    rows.some(row => isFiniteNumeric(row[header]))
  );
}

export function getTimeSeriesColumnDefaults(
  data: ParsedCSV,
  selectedDateColumn?: string,
  selectedValueColumn?: string
): { dateColumn: string; valueColumn: string; valueColumns: string[]; detectedDateColumn: string | null } {
  const detectedDateColumn = detectDateColumn(data.rows, data.headers);
  const dateColumn =
    (selectedDateColumn && data.headers.includes(selectedDateColumn))
      ? selectedDateColumn
      : detectedDateColumn ?? data.headers[0] ?? '';
  const valueColumns = getTimeSeriesValueColumns(data.rows, data.headers, dateColumn);
  const valueColumn =
    (selectedValueColumn && valueColumns.includes(selectedValueColumn))
      ? selectedValueColumn
      : valueColumns[0] ?? '';

  return { dateColumn, valueColumn, valueColumns, detectedDateColumn };
}

export function getSelectedTimeSeriesTransformation(): TimeSeriesTransformationKey {
  const select = $('qb-ts-transform') as HTMLSelectElement | null;
  const value = select?.value;
  if (
    value === 'difference' ||
    value === 'percentReturn' ||
    value === 'logReturn' ||
    value === 'base100' ||
    value === 'movingAverage'
  ) {
    return value;
  }
  return 'original';
}

export function getMovingAverageWindow(defaultValue = 3): number {
  const input = $('qb-ts-ma-window') as HTMLInputElement | null;
  const parsed = Number(input?.value);
  return Number.isInteger(parsed) ? parsed : defaultValue;
}

export function getACFMaxLag(defaultValue = 12): number {
  const input = $('qb-ts-acf-max-lag') as HTMLInputElement | null;
  const parsed = Number(input?.value);
  return Number.isInteger(parsed) ? parsed : defaultValue;
}

export function syncTimeSeriesTransformationControls(observations?: number, transformedObservations?: number): void {
  const transform = getSelectedTimeSeriesTransformation();
  const wrap = $('qb-ts-ma-window-wrap') as HTMLElement | null;
  const input = $('qb-ts-ma-window') as HTMLInputElement | null;
  if (wrap) wrap.style.display = transform === 'movingAverage' ? '' : 'none';
  if (input && observations !== undefined) {
    const max = Math.max(2, observations - 1);
    input.max = String(max);
    if (!input.value) input.value = '3';
  }

  const acfInput = $('qb-ts-acf-max-lag') as HTMLInputElement | null;
  if (acfInput) {
    const acfObservations = transformedObservations ?? observations ?? 0;
    const acfMax = Math.max(1, Math.min(40, Math.floor((acfObservations - 1) / 2)));
    acfInput.max = String(acfMax);
    if (!acfInput.value) acfInput.value = String(Math.min(12, acfMax));
  }
}
export function renderTimeSeriesNoData(message = 'Subi un CSV para analizar una serie temporal.'): void {
  const panel = $('qb-ts-panel');
  const empty = $('qb-ts-empty');
  const controls = $('qb-ts-controls');
  if (panel) panel.style.display = '';
  if (empty) {
    empty.textContent = message;
    empty.style.display = '';
  }
  if (controls) controls.style.display = 'none';
  renderTimeSeriesWarnings([]);
  renderTimeSeriesSummary(null);
  renderTransformedSummary(null);
  renderACFDiagnostics(null);
  renderTimeSeriesInterpretation([]);
  destroyTimeSeriesChart();
}

export function renderTimeSeriesSelectors(
  data: ParsedCSV,
  selectedDateColumn?: string,
  selectedValueColumn?: string
): void {
  const empty = $('qb-ts-empty');
  const controls = $('qb-ts-controls');
  const dateSelect = $('qb-ts-date') as HTMLSelectElement | null;
  const valueSelect = $('qb-ts-value') as HTMLSelectElement | null;
  const runButton = $('qb-ts-run') as HTMLButtonElement | null;

  if (!data.headers.length) {
    renderTimeSeriesNoData('El CSV no tiene columnas disponibles para Time Series.');
    return;
  }

  const { dateColumn, valueColumn, valueColumns, detectedDateColumn } = getTimeSeriesColumnDefaults(
    data,
    selectedDateColumn,
    selectedValueColumn
  );

  if (empty) empty.style.display = 'none';
  if (controls) controls.style.display = '';
  if (dateSelect) {
    dateSelect.innerHTML = data.headers.map(optionHtml).join('');
    dateSelect.value = dateColumn;
  }
  if (valueSelect) {
    valueSelect.innerHTML = valueColumns.map(optionHtml).join('');
    valueSelect.value = valueColumn;
  }
  if (runButton) runButton.disabled = !dateColumn || !valueColumn;

  const warnings: string[] = [];
  if (!detectedDateColumn) warnings.push('No se detecto una columna de fecha candidata. Elegi una columna manualmente.');
  if (valueColumns.length === 0) warnings.push('No se detecto una columna de valor numerica.');
  renderTimeSeriesWarnings(warnings);
  renderTimeSeriesSummary(null);
  renderTransformedSummary(null);
  renderACFDiagnostics(null);
  renderTimeSeriesInterpretation([]);
  syncTimeSeriesTransformationControls();
  destroyTimeSeriesChart();
}

function issueToText(issue: TimeSeriesValidationIssue): string {
  switch (issue.type) {
    case 'missing_date_column':
      return 'No se detecto una columna de fecha parseable.';
    case 'invalid_date':
      return `Fecha invalida${issue.rowIndex !== undefined ? ` en fila ${issue.rowIndex + 1}` : ''}.`;
    case 'duplicate_date':
      return `Fecha duplicada${issue.dateKey ? `: ${issue.dateKey}` : ''}.`;
    case 'missing_value':
      return `Valor faltante o no numerico${issue.rowIndex !== undefined ? ` en fila ${issue.rowIndex + 1}` : ''}.`;
    case 'empty_series':
      return 'No hay observaciones validas para Time Series.';
    case 'insufficient_observations':
      return 'Hay menos de 3 observaciones validas.';
    default:
      return issue.message;
  }
}

function renderTimeSeriesWarnings(messages: string[]): void {
  const el = $('qb-ts-warnings');
  if (!el) return;
  el.innerHTML = messages.length > 0
    ? `<div class="qb-warn-yellow"><ul>${messages.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul></div>`
    : '';
}

function renderTransformedSummary(transformed: TimeSeriesTransformedSeries | null): void {
  const el = $('qb-ts-transform-summary');
  if (!el) return;
  if (!transformed) {
    el.innerHTML = '';
    return;
  }

  const { summary } = transformed;
  el.innerHTML = `
    <table class="ledger">
      <thead><tr><th>Transformacion</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td>Serie</td><td>${escapeHtml(transformed.label)}</td></tr>
        <tr><td>Observaciones</td><td>${summary.observations}</td></tr>
        <tr><td>Inicio</td><td>${formatDate(summary.startDate)}</td></tr>
        <tr><td>Fin</td><td>${formatDate(summary.endDate)}</td></tr>
        <tr><td>Minimo</td><td>${formatNumber(summary.min)}</td></tr>
        <tr><td>Maximo</td><td>${formatNumber(summary.max)}</td></tr>
        <tr><td>Media</td><td>${formatNumber(summary.mean)}</td></tr>
        <tr><td>Desv. estandar</td><td>${formatNumber(summary.stdDev)}</td></tr>
      </tbody>
    </table>`;
}

function renderACFDiagnostics(acf: TimeSeriesACFDiagnostics | null): void {
  const el = $('qb-ts-acf-table');
  const ljungBoxEl = $('qb-ts-ljung-box-table');
  const warningsEl = $('qb-ts-acf-warnings');
  const interpEl = $('qb-ts-acf-interpretation');

  if (!acf) {
    if (el) el.innerHTML = '';
    if (ljungBoxEl) ljungBoxEl.innerHTML = '';
    if (warningsEl) warningsEl.innerHTML = '';
    if (interpEl) interpEl.textContent = '';
    return;
  }

  if (warningsEl) {
    warningsEl.innerHTML = acf.warnings.length > 0
      ? `<div class="qb-warn-yellow"><ul>${acf.warnings.map(message => `<li>${escapeHtml(message)}</li>`).join('')}</ul></div>`
      : '';
  }

  if (el) {
    if (acf.rows.length === 0) {
      el.innerHTML = '<div class="qb-interp">ACF no disponible para la serie transformada seleccionada.</div>';
    } else {
      el.innerHTML = `
        <table class="ledger">
          <thead><tr><th>Lag</th><th>Autocorrelacion</th><th>Umbral aprox.</th><th>Fuera del umbral</th></tr></thead>
          <tbody>
            ${acf.rows.map(row => `
              <tr>
                <td>${row.lag}</td>
                <td>${formatNumber(row.autocorrelation)}</td>
                <td>+/- ${formatNumber(row.threshold)}</td>
                <td>${row.outsideThreshold ? 'Si' : 'No'}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  }

  if (ljungBoxEl) {
    if (acf.ljungBox.length === 0) {
      ljungBoxEl.innerHTML = '<div class="qb-interp">Ljung-Box no disponible para las ventanas de lag seleccionadas.</div>';
    } else {
      ljungBoxEl.innerHTML = `
        <table class="ledger">
          <thead><tr><th>Lag</th><th>Q Ljung-Box</th><th>p-valor</th><th>Interpretacion</th></tr></thead>
          <tbody>
            ${acf.ljungBox.map(row => `
              <tr>
                <td>${row.lag}</td>
                <td>${formatNumber(row.qStatistic)}</td>
                <td>${formatNumber(row.pValue)}</td>
                <td>${escapeHtml(row.interpretation)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`;
    }
  }

  if (interpEl) interpEl.textContent = acf.interpretation;
}
function renderTimeSeriesSummary(summary: TimeSeriesSummary | null): void {
  const el = $('qb-ts-summary');
  if (!el) return;
  if (!summary) {
    el.innerHTML = '';
    return;
  }

  el.innerHTML = `
    <table class="ledger">
      <thead><tr><th>Indicador</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td>Observaciones</td><td>${summary.observations}</td></tr>
        <tr><td>Inicio</td><td>${formatDate(summary.startDate)}</td></tr>
        <tr><td>Fin</td><td>${formatDate(summary.endDate)}</td></tr>
        <tr><td>Minimo</td><td>${formatNumber(summary.min)}</td></tr>
        <tr><td>Maximo</td><td>${formatNumber(summary.max)}</td></tr>
        <tr><td>Media</td><td>${formatNumber(summary.mean)}</td></tr>
        <tr><td>Frecuencia aproximada</td><td>${escapeHtml(summary.frequency)}</td></tr>
      </tbody>
    </table>`;
}

function renderTimeSeriesInterpretation(lines: string[]): void {
  const el = $('qb-ts-interpretation');
  if (!el) return;
  el.textContent = lines.join('\n');
}

function scheduleTimeSeriesChartRender(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => {
      pendingTimeSeriesChartFrame = null;
      callback();
    });
    pendingTimeSeriesChartFrame = { id, type: 'animationFrame' };
    return;
  }

  const id = window.setTimeout(() => {
    pendingTimeSeriesChartFrame = null;
    callback();
  }, 0);
  pendingTimeSeriesChartFrame = { id, type: 'timeout' };
}

function cancelPendingTimeSeriesChartRender(): void {
  if (pendingTimeSeriesChartFrame === null) return;
  if (pendingTimeSeriesChartFrame.type === 'animationFrame') {
    cancelAnimationFrame(pendingTimeSeriesChartFrame.id);
  } else {
    clearTimeout(pendingTimeSeriesChartFrame.id);
  }
  pendingTimeSeriesChartFrame = null;
}

function createTimeSeriesChart(result: TimeSeriesAnalysisResult): void {
  const canvas = $('qb-ts-chart') as HTMLCanvasElement | null;
  if (!canvas || typeof Chart === 'undefined') return;
  const points = result.selectedTransformation.points;
  if (points.length === 0) return;

  timeSeriesChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: points.map(row => formatDate(row.date)),
      datasets: [
        {
          label: result.selectedTransformation.label,
          data: points.map(row => row.value),
          borderColor: '#1b3a6b',
          backgroundColor: 'rgba(27,58,107,.12)',
          pointRadius: 2,
          tension: 0.15,
        },
      ],
    },
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
  timeSeriesChart.resize();
}

function renderTimeSeriesChart(result: TimeSeriesAnalysisResult): void {
  destroyTimeSeriesChart();
  if (result.selectedTransformation.points.length === 0) return;

  scheduleTimeSeriesChartRender(() => createTimeSeriesChart(result));
}

export function renderTimeSeriesAnalysis(result: TimeSeriesAnalysisResult): void {
  const panel = $('qb-ts-panel');
  const empty = $('qb-ts-empty');
  if (panel) panel.style.display = '';
  if (empty) empty.style.display = 'none';
  renderTimeSeriesWarnings([
    ...result.validation.issues.map(issueToText),
    ...result.selectedTransformation.warnings,
  ]);
  renderTimeSeriesSummary(result.summary);
  renderTransformedSummary(result.selectedTransformation);
  renderACFDiagnostics(result.acf);
  renderTimeSeriesInterpretation([
    ...result.interpretation,
    '',
    result.selectedTransformation.interpretation,
  ]);
  syncTimeSeriesTransformationControls(result.summary.observations, result.selectedTransformation.summary.observations);
  renderTimeSeriesChart(result);
}

export function destroyTimeSeriesChart(): void {
  cancelPendingTimeSeriesChartRender();
  if (timeSeriesChart) {
    timeSeriesChart.destroy();
    timeSeriesChart = null;
  }
}

export function resetTimeSeriesView(): void {
  renderTimeSeriesWarnings([]);
  renderTimeSeriesSummary(null);
  renderTransformedSummary(null);
  renderACFDiagnostics(null);
  renderTimeSeriesInterpretation([]);
  destroyTimeSeriesChart();
}
