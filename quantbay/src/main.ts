import { parseCSVFile, getValidRows } from './csvParser';
import { runOLS, type RegressionResult } from './regression';
import { interpret } from './interpretation';

declare const Chart: any; // loaded via CDN

interface CSVData {
  headers: string[];
  rows: Record<string, unknown>[];
  numericColumns: string[];
}

let csvData: CSVData | null = null;
let activeChart: any = null;

const $ = (id: string): HTMLElement | null => document.getElementById(id);

function esc(s: unknown): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );
}

function showError(msg: string): void {
  const el = $('qb-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

// ── Upload ────────────────────────────────────────────────────────────────────

async function onFileChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  showError('');
  const fn = $('qb-filename');
  if (fn) fn.textContent = file.name;

  try {
    csvData = await parseCSVFile(file);
    if (csvData.numericColumns.length < 2) {
      showError('El CSV necesita al menos 2 columnas numéricas.');
      return;
    }
    renderPreview(csvData);
    renderVarSelectors(csvData.numericColumns);
    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = '';
    if (results) results.style.display = 'none';
  } catch (err) {
    showError(`Error al leer el archivo: ${(err as Error).message}`);
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────

function renderPreview({ headers, rows, numericColumns }: CSVData): void {
  const preview = rows.slice(0, 6);
  const thead = `<tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>`;
  const tbody = preview
    .map(row => `<tr>${headers.map(h => `<td>${esc(row[h])}</td>`).join('')}</tr>`)
    .join('');
  const wrap = $('qb-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
    </div>
    <p class="muted" style="font-size:11px;margin:4px 0 0">
      ${preview.length} de ${rows.length} filas · ${headers.length} columnas ·
      <strong>${numericColumns.length} numéricas</strong>
    </p>`;
}

// ── Variable selectors ────────────────────────────────────────────────────────

function renderVarSelectors(cols: string[]): void {
  const yEl = $('qb-y') as HTMLSelectElement | null;
  const xEl = $('qb-x-checks');
  if (yEl) yEl.innerHTML = cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  if (xEl)
    xEl.innerHTML = cols
      .map(
        (c, i) =>
          `<label class="qb-x-check"><input type="checkbox" class="qb-x-cb" value="${esc(c)}" ${i > 0 ? 'checked' : ''}> ${esc(c)}</label>`
      )
      .join('');
}

// ── Run regression ────────────────────────────────────────────────────────────

function onRun(): void {
  if (!csvData) return;
  showError('');
  const yName = ($('qb-y') as HTMLSelectElement)?.value ?? '';
  const xNames = Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v !== yName);

  if (xNames.length === 0) {
    showError('Seleccioná al menos una variable X distinta de Y.');
    return;
  }

  const { X, y, dropped } = getValidRows(csvData.rows, yName, xNames);
  if (y.length < xNames.length + 2) {
    showError(`Observaciones insuficientes (${y.length}) para ${xNames.length} variable(s).`);
    return;
  }

  try {
    const result = runOLS({ X, y, featureNames: xNames, yName });
    renderResults(result, dropped);
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
  } catch (err) {
    showError(`Error en la regresión: ${(err as Error).message}`);
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

function renderResults(result: RegressionResult, dropped: number): void {
  const eq = $('qb-equation');
  if (eq) eq.textContent = result.equation;

  const coefBody = $('qb-coef-body');
  if (coefBody)
    coefBody.innerHTML = [
      `<tr><td>Intercepto</td><td>${result.intercept.toFixed(6)}</td></tr>`,
      ...result.featureNames.map(
        (n, i) => `<tr><td>${esc(n)}</td><td>${result.coefficients[i].toFixed(6)}</td></tr>`
      ),
    ].join('');

  const statsBody = $('qb-stats-body');
  if (statsBody)
    statsBody.innerHTML = `
      <tr><td>R²</td><td>${result.rSquared.toFixed(6)}</td></tr>
      <tr><td>R² ajustado</td><td>${result.adjustedRSquared.toFixed(6)}</td></tr>
      <tr><td>Observaciones (n)</td><td>${result.nObs}</td></tr>
      <tr><td>Variables (k)</td><td>${result.nFeatures}</td></tr>
      ${dropped > 0 ? `<tr><td>Filas omitidas (NA)</td><td>${dropped}</td></tr>` : ''}`;

  renderChart(result);

  const interp = $('qb-interpretation');
  if (interp) interp.textContent = interpret(result);

  const actual = result.predictions.map((p, i) => p + result.residuals[i]);
  const predTable = $('qb-pred-table');
  if (predTable)
    predTable.innerHTML = `
      <table class="ledger" style="margin-top:8px">
        <thead><tr><th>#</th><th>Real</th><th>Predicho</th><th>Residuo</th></tr></thead>
        <tbody>${result.predictions
          .map(
            (p, i) =>
              `<tr><td>${i + 1}</td><td>${actual[i].toFixed(4)}</td><td>${p.toFixed(4)}</td><td>${result.residuals[i].toFixed(4)}</td></tr>`
          )
          .join('')}</tbody>
      </table>`;
}

function renderChart(result: RegressionResult): void {
  const canvas = $('qb-chart') as HTMLCanvasElement | null;
  if (activeChart) { activeChart.destroy(); activeChart = null; }
  if (typeof Chart === 'undefined' || !canvas) return;

  const actual = result.predictions.map((p, i) => p + result.residuals[i]);
  const allV = [...actual, ...result.predictions];
  const minV = Math.min(...allV), maxV = Math.max(...allV);
  const pad = (maxV - minV) * 0.05 || 1;

  activeChart = new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Observaciones',
          data: actual.map((a, i) => ({ x: a, y: result.predictions[i] })),
          backgroundColor: '#1b3a6b88',
          borderColor: '#1b3a6b',
          pointRadius: 5,
          pointHoverRadius: 7,
        },
        {
          label: 'Ajuste perfecto (y = x)',
          data: [{ x: minV - pad, y: minV - pad }, { x: maxV + pad, y: maxV + pad }],
          type: 'line',
          borderColor: '#b8860b',
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { font: { family: 'Verdana', size: 11 } } },
        title: {
          display: true,
          text: `${result.yName}: Real vs. Predicho`,
          font: { family: 'Verdana', size: 12 },
        },
      },
      scales: {
        x: {
          title: {
            display: true,
            text: `Real (${result.yName})`,
            font: { family: 'Verdana', size: 11 },
          },
        },
        y: {
          title: {
            display: true,
            text: `Predicho (${result.yName})`,
            font: { family: 'Verdana', size: 11 },
          },
        },
      },
    },
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  $('qb-file')?.addEventListener('change', onFileChange as EventListener);
  $('qb-run')?.addEventListener('click', onRun);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
