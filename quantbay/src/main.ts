import { parseCSVFile, getValidRows } from './csvParser';
import { runOLS, computeVIF, type RegressionResult } from './regression';
import { pearsonMatrix } from './statistics';
import { interpret } from './interpretation';

declare const Chart: any;
declare const jspdf: any; // window.jspdf from CDN

interface CSVData {
  headers: string[];
  rows: Record<string, unknown>[];
  numericColumns: string[];
}

let csvData: CSVData | null = null;
let activeChart: any = null;
let residFittedChart: any = null;
let residHistChart: any = null;
let lastResult: RegressionResult | null = null;
let lastCorr: number[][] | null = null;
let lastCorrCols: string[] | null = null;
let lastVIF: number[] | null = null;

const $ = (id: string): HTMLElement | null => document.getElementById(id);

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );

function showError(msg: string): void {
  const el = $('qb-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

function sigBadge(p: number): string {
  if (p < 0.01) return '<span class="sig-badge sig-h">*** p&lt;0.01</span>';
  if (p < 0.05) return '<span class="sig-badge sig-m">** p&lt;0.05</span>';
  if (p < 0.10) return '<span class="sig-badge sig-l">* p&lt;0.10</span>';
  return '<span class="sig-badge sig-n">n.s.</span>';
}

function sigLabel(p: number): string {
  if (p < 0.01) return '***';
  if (p < 0.05) return '**';
  if (p < 0.10) return '*';
  return 'n.s.';
}

function corrCls(r: number, isDiag: boolean): string {
  if (isDiag) return 'corr-diag';
  if (r >= 0.7) return 'corr-sp';
  if (r <= -0.7) return 'corr-sn';
  if (r >= 0.3) return 'corr-mp';
  if (r <= -0.3) return 'corr-mn';
  return 'corr-w';
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

function getAllNumericData(
  rows: Record<string, unknown>[],
  colNames: string[]
): number[][] {
  const valid = rows.filter(row =>
    colNames.every(c => { const v = Number(row[c]); return !isNaN(v) && isFinite(v); })
  );
  return colNames.map(col => valid.map(row => Number(row[col])));
}

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

    const allColData = getAllNumericData(csvData.rows, csvData.numericColumns);
    const corrMatrix = pearsonMatrix(allColData);
    const vifValues = computeVIF(X);

    lastResult = result;
    lastCorr = corrMatrix;
    lastCorrCols = csvData.numericColumns;
    lastVIF = vifValues;

    renderResults(result, dropped, corrMatrix, csvData.numericColumns, vifValues);
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
  } catch (err) {
    showError(`Error en la regresión: ${(err as Error).message}`);
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

function renderResults(
  result: RegressionResult,
  dropped: number,
  corrMatrix: number[][],
  corrCols: string[],
  vifValues: number[]
): void {
  const eq = $('qb-equation');
  if (eq) eq.textContent = result.equation;

  renderCoefTable(result);
  renderStatsTable(result, dropped);
  renderChart(result);
  renderCorrMatrix(corrMatrix, corrCols);
  renderVIF(vifValues, result.featureNames);
  renderResidDiag(result);

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

function renderCoefTable(result: RegressionResult): void {
  const body = $('qb-coef-body');
  if (!body) return;
  const fmt6 = (n: number) => (isFinite(n) ? n.toFixed(6) : '—');
  const fmt4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '—');
  body.innerHTML = [
    `<tr>
      <td>Intercepto</td>
      <td>${fmt6(result.intercept)}</td>
      <td>${fmt6(result.stdErrors[0])}</td>
      <td>${fmt4(result.tStats[0])}</td>
      <td>${fmt4(result.pValues[0])}</td>
      <td>${sigBadge(result.pValues[0])}</td>
    </tr>`,
    ...result.featureNames.map(
      (n, i) => `<tr>
        <td>${esc(n)}</td>
        <td>${fmt6(result.coefficients[i])}</td>
        <td>${fmt6(result.stdErrors[i + 1])}</td>
        <td>${fmt4(result.tStats[i + 1])}</td>
        <td>${fmt4(result.pValues[i + 1])}</td>
        <td>${sigBadge(result.pValues[i + 1])}</td>
      </tr>`
    ),
  ].join('');
}

function renderStatsTable(result: RegressionResult, dropped: number): void {
  const body = $('qb-stats-body');
  if (!body) return;
  body.innerHTML = `
    <tr><td>R²</td><td>${result.rSquared.toFixed(6)}</td></tr>
    <tr><td>R² ajustado</td><td>${result.adjustedRSquared.toFixed(6)}</td></tr>
    <tr><td>Observaciones (n)</td><td>${result.nObs}</td></tr>
    <tr><td>Variables (k)</td><td>${result.nFeatures}</td></tr>
    <tr><td>Grados de libertad</td><td>${result.df}</td></tr>
    <tr><td>σ² (var. residual)</td><td>${result.sigma2.toFixed(6)}</td></tr>
    ${dropped > 0 ? `<tr><td>Filas omitidas (NA)</td><td>${dropped}</td></tr>` : ''}`;
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
        x: { title: { display: true, text: `Real (${result.yName})`, font: { family: 'Verdana', size: 11 } } },
        y: { title: { display: true, text: `Predicho (${result.yName})`, font: { family: 'Verdana', size: 11 } } },
      },
    },
  });
}

// ── Correlation matrix ────────────────────────────────────────────────────────

function renderCorrMatrix(corrMatrix: number[][], colNames: string[]): void {
  const wrap = $('qb-corr-wrap');
  if (!wrap || !corrMatrix || corrMatrix.length === 0) return;
  const k = colNames.length;
  const abbr = (n: string) => (n.length > 9 ? n.slice(0, 8) + '…' : n);

  let html = '<table class="ledger qb-corr-table"><thead><tr><th></th>';
  html += colNames.map(n => `<th title="${esc(n)}">${esc(abbr(n))}</th>`).join('');
  html += '</tr></thead><tbody>';
  for (let i = 0; i < k; i++) {
    html += `<tr><th title="${esc(colNames[i])}">${esc(abbr(colNames[i]))}</th>`;
    for (let j = 0; j < k; j++) {
      const r = corrMatrix[i][j];
      html += `<td class="${corrCls(r, i === j)}">${r.toFixed(3)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;

  const interpEl = $('qb-corr-interp');
  if (!interpEl) return;
  const lines: string[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const r = corrMatrix[i][j];
      const abs = Math.abs(r);
      if (abs >= 0.7) {
        const dir = r > 0 ? 'positiva' : 'negativa';
        const str = abs >= 0.9 ? 'muy fuerte' : 'fuerte';
        lines.push(`"${colNames[i]}" y "${colNames[j]}" — correlación ${dir} ${str} (r = ${r.toFixed(3)}).`);
      }
    }
  }
  interpEl.textContent = lines.length > 0
    ? lines.join('\n')
    : 'No se detectan correlaciones fuertes (|r| ≥ 0.70) entre las variables.';
  interpEl.style.display = '';
}

// ── VIF ───────────────────────────────────────────────────────────────────────

function renderVIF(vifValues: number[], xNames: string[]): void {
  const wrap = $('qb-vif-wrap');
  const warnEl = $('qb-vif-warn');
  if (!wrap) return;

  if (!vifValues || vifValues.length === 0) {
    wrap.innerHTML = '<p class="muted" style="font-size:11px">VIF no disponible con un solo predictor.</p>';
    return;
  }

  const warnings: string[] = [];
  let html = '<table class="ledger"><thead><tr><th>Variable</th><th>VIF</th><th>Estado</th></tr></thead><tbody>';
  vifValues.forEach((v, i) => {
    const vStr = v >= 999 ? '&gt;999' : v.toFixed(2);
    let cls: string, label: string;
    if (v >= 10) {
      cls = 'qb-vif-high'; label = '⚠ Severo';
      warnings.push(`"${xNames[i]}" (VIF ${v >= 999 ? '>999' : v.toFixed(1)}): multicolinealidad severa — los coeficientes pueden ser inestables.`);
    } else if (v >= 5) {
      cls = 'qb-vif-med'; label = '△ Precaución';
    } else {
      cls = 'qb-vif-ok'; label = '✓ Aceptable';
    }
    html += `<tr><td>${esc(xNames[i])}</td><td>${vStr}</td><td class="${cls}">${label}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  if (warnEl) {
    warnEl.innerHTML = warnings.length > 0
      ? `<div class="qb-warn">${warnings.map(w => `<p>${esc(w)}</p>`).join('')}</div>`
      : '';
  }
}

// ── Residual diagnostics ──────────────────────────────────────────────────────

function renderResidDiag(result: RegressionResult): void {
  if (typeof Chart === 'undefined') return;

  const rfCanvas = $('qb-resid-fitted') as HTMLCanvasElement | null;
  if (rfCanvas) {
    if (residFittedChart) { residFittedChart.destroy(); residFittedChart = null; }
    const minP = Math.min(...result.predictions);
    const maxP = Math.max(...result.predictions);
    residFittedChart = new Chart(rfCanvas, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: 'Residuos',
            data: result.predictions.map((p, i) => ({ x: p, y: result.residuals[i] })),
            backgroundColor: '#1b3a6b88',
            borderColor: '#1b3a6b',
            pointRadius: 4,
          },
          {
            label: 'y=0',
            type: 'line',
            data: [{ x: minP, y: 0 }, { x: maxP, y: 0 }],
            borderColor: '#b8860b',
            borderDash: [5, 3],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Residuos vs. Ajustados', font: { family: 'Verdana', size: 11 } },
        },
        scales: {
          x: { title: { display: true, text: 'Valor ajustado', font: { family: 'Verdana', size: 10 } } },
          y: { title: { display: true, text: 'Residuo', font: { family: 'Verdana', size: 10 } } },
        },
      },
    });
  }

  const histCanvas = $('qb-resid-hist') as HTMLCanvasElement | null;
  if (histCanvas) {
    if (residHistChart) { residHistChart.destroy(); residHistChart = null; }
    const resids = result.residuals;
    const minR = Math.min(...resids), maxR = Math.max(...resids);
    const bins = Math.min(10, Math.max(3, Math.floor(Math.sqrt(resids.length))));
    const bw = (maxR - minR) / bins || 1;
    const counts = new Array(bins).fill(0);
    resids.forEach(r => { const idx = Math.min(Math.floor((r - minR) / bw), bins - 1); counts[idx]++; });
    const labels = Array.from({ length: bins }, (_, i) => (minR + (i + 0.5) * bw).toFixed(2));
    residHistChart = new Chart(histCanvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: counts, backgroundColor: '#1b3a6b88', borderColor: '#1b3a6b', borderWidth: 1 }] },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          title: { display: true, text: 'Distribución de Residuos', font: { family: 'Verdana', size: 11 } },
        },
        scales: {
          x: { title: { display: true, text: 'Residuo', font: { family: 'Verdana', size: 10 } } },
          y: { title: { display: true, text: 'Frecuencia', font: { family: 'Verdana', size: 10 } }, beginAtZero: true },
        },
      },
    });
  }

  const statsEl = $('qb-resid-stats');
  if (statsEl) {
    const n = result.residuals.length;
    const mn = result.residuals.reduce((s, r) => s + r, 0) / n;
    const sd = Math.sqrt(result.residuals.reduce((s, r) => s + (r - mn) ** 2, 0) / Math.max(1, n - 1));
    statsEl.innerHTML = `<p class="qb-resid-stat-line">Media de residuos: <strong>${mn.toFixed(6)}</strong> &nbsp;·&nbsp; Desv. estándar: <strong>${sd.toFixed(6)}</strong></p>`;
  }
}

// ── PDF Export ────────────────────────────────────────────────────────────────

function exportPDF(): void {
  const jspdfLib = (window as any).jspdf;
  if (!jspdfLib?.jsPDF) { alert('jsPDF no disponible. Verificá que el CDN cargó.'); return; }
  if (!lastResult) { alert('Primero ejecutá una regresión.'); return; }

  const { jsPDF } = jspdfLib;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 190;
  let y = 15;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('Quant Bay — Análisis de Regresión OLS', 10, y);
  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text('Generado por ChartBay · ' + new Date().toLocaleDateString('es-AR'), 10, y);
  y += 8;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Ecuación estimada:', 10, y);
  y += 5;
  doc.setFont('courier', 'normal');
  doc.setFontSize(8);
  const eqLines = doc.splitTextToSize(lastResult.equation, W);
  doc.text(eqLines, 10, y);
  y += eqLines.length * 4 + 5;

  if (doc.autoTable) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Coeficientes y Significancia', 10, y);
    y += 4;
    doc.autoTable({
      head: [['Variable', 'Coef.', 'Err. Est.', 't-stat', 'p-valor', 'Signif.']],
      body: [
        ['Intercepto', lastResult.intercept.toFixed(6), lastResult.stdErrors[0].toFixed(6),
          isFinite(lastResult.tStats[0]) ? lastResult.tStats[0].toFixed(4) : '—',
          lastResult.pValues[0].toFixed(4), sigLabel(lastResult.pValues[0])],
        ...lastResult.featureNames.map((n, i) => [n,
          lastResult!.coefficients[i].toFixed(6),
          lastResult!.stdErrors[i + 1].toFixed(6),
          isFinite(lastResult!.tStats[i + 1]) ? lastResult!.tStats[i + 1].toFixed(4) : '—',
          lastResult!.pValues[i + 1].toFixed(4), sigLabel(lastResult!.pValues[i + 1])]),
      ],
      startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Estadísticos del Modelo', 10, y);
    y += 4;
    doc.autoTable({
      head: [['Indicador', 'Valor']],
      body: [
        ['R²', lastResult.rSquared.toFixed(6)],
        ['R² ajustado', lastResult.adjustedRSquared.toFixed(6)],
        ['n (observaciones)', String(lastResult.nObs)],
        ['k (variables)', String(lastResult.nFeatures)],
        ['Grados de libertad', String(lastResult.df)],
        ['σ² (varianza residual)', lastResult.sigma2.toFixed(6)],
      ],
      startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const chartCanvas = $('qb-chart') as HTMLCanvasElement | null;
  if (chartCanvas) {
    if (y > 220) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Real vs. Predicho', 10, y);
    y += 4;
    try { doc.addImage(chartCanvas.toDataURL('image/png'), 'PNG', 10, y, W, 65); y += 69; } catch (_) {}
  }

  if (lastCorr && lastCorrCols && doc.autoTable) {
    if (y > 200) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Matriz de Correlación de Pearson', 10, y);
    y += 4;
    doc.autoTable({
      head: [['', ...lastCorrCols]],
      body: lastCorr.map((row, i) => [lastCorrCols![i], ...row.map(v => v.toFixed(3))]),
      startY: y, styles: { fontSize: 7 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  if (lastVIF && doc.autoTable) {
    if (y > 220) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Diagnóstico de Multicolinealidad (VIF)', 10, y);
    y += 4;
    doc.autoTable({
      head: [['Variable', 'VIF', 'Estado']],
      body: lastVIF.map((v, i) => [
        lastResult!.featureNames[i],
        v >= 999 ? '>999' : v.toFixed(2),
        v >= 10 ? 'Severo' : v >= 5 ? 'Precaución' : 'Aceptable',
      ]),
      startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
    });
    y = doc.lastAutoTable.finalY + 5;
  }

  const rfCanvas = $('qb-resid-fitted') as HTMLCanvasElement | null;
  const rhCanvas = $('qb-resid-hist') as HTMLCanvasElement | null;
  if (rfCanvas || rhCanvas) {
    if (y > 200) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Diagnósticos de Residuos', 10, y);
    y += 4;
    try {
      if (rfCanvas) doc.addImage(rfCanvas.toDataURL('image/png'), 'PNG', 10, y, 90, 55);
      if (rhCanvas) doc.addImage(rhCanvas.toDataURL('image/png'), 'PNG', 105, y, 90, 55);
      y += 59;
    } catch (_) {}
  }

  if (y > 230) { doc.addPage(); y = 15; }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('Interpretación Automática', 10, y);
  y += 5;
  const interpEl = $('qb-interpretation');
  if (interpEl) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(interpEl.textContent ?? '', W);
    doc.text(lines, 10, y);
  }

  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7);
    doc.text('Análisis estadístico educativo · No constituye asesoramiento financiero.', 10, 290);
    doc.text(`Pág. ${i}/${pageCount}`, 185, 290);
  }

  doc.save('quantbay_regresion.pdf');
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  $('qb-file')?.addEventListener('change', onFileChange as EventListener);
  $('qb-run')?.addEventListener('click', onRun);
  $('qb-export-pdf')?.addEventListener('click', exportPDF);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
