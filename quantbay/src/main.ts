import { parseCSVFile, type ParsedCSV } from './csvParser';
import type { RegressionResult } from './regression';
import { interpret } from './interpretation';
import {
  runQuantAnalysis,
  type LeakageSignal,
  type LogisticResult,
} from './services/analysisService';
import { autoRepairAndAnalyze, type AutoRepairResult } from './services/autoRepair';
import {
  correlationClass,
  escapeHtml,
  significanceBadge,
  significanceLabel,
} from './utils/format';

declare const Chart: any;
declare const jspdf: any; // window.jspdf from CDN

let csvData: ParsedCSV | null = null;
let activeChart: any = null;
let residFittedChart: any = null;
let residHistChart: any = null;
let lastResult: RegressionResult | null = null;
let lastCorr: number[][] | null = null;
let lastCorrCols: string[] | null = null;
let lastVIF: number[] | null = null;
let lastLogit: LogisticResult | null = null;

const $ = (id: string): HTMLElement | null => document.getElementById(id);

interface QuantDemoCase {
  id: string;
  label: string;
  file: string;
  yName: string;
  xNames: string[];
  restriction: string;
  description: string;
}

const DEMO_CASES: Record<string, QuantDemoCase> = {
  'ols-simple': {
    id: 'ols-simple',
    label: 'OLS simple',
    file: '01_simple_linear.csv',
    yName: 'y',
    xNames: ['x'],
    restriction: 'Sin restriccion: modelo OLS simple y = beta0 + beta1*x + error.',
    description: 'Relacion lineal clara para verificar intercepto, pendiente, RSS y diagnosticos basicos.',
  },
  'rls-beta1-zero': {
    id: 'rls-beta1-zero',
    label: 'RLS beta1 = 0',
    file: '01_simple_linear.csv',
    yName: 'y',
    xNames: ['x'],
    restriction: 'Restriccion sugerida: beta1 = 0.',
    description: 'Usa el dataset simple para contrastar una pendiente nula contra el ajuste OLS completo.',
  },
  'rls-beta1-beta2': {
    id: 'rls-beta1-beta2',
    label: 'RLS beta1 = beta2',
    file: '02_beta1_eq_beta2_approx_valid.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Restriccion sugerida: beta1 - beta2 = 0.',
    description: 'Caso donde beta1 y beta2 son aproximadamente iguales; la restriccion no deberia rechazarse a niveles usuales.',
  },
  'rls-sum-one': {
    id: 'rls-sum-one',
    label: 'RLS beta1 + beta2 = 1',
    file: '04_beta1_plus_beta2_eq_1.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Restriccion sugerida: beta1 + beta2 = 1.',
    description: 'Dataset para comprobar una restriccion lineal sobre la suma de coeficientes.',
  },
  singular: {
    id: 'singular',
    label: 'Caso singular',
    file: '05_perfect_collinearity.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Restriccion sugerida: beta1 - beta2 = 0; primero debe detectarse x2 = 2*x1.',
    description: 'Caso de colinealidad perfecta: la matriz de diseno no tiene rango completo y el modelo debe avisar antes de estimar.',
  },
};

function showError(msg: string): void {
  const el = $('qb-error');
  if (!el) return;
  el.textContent = msg;
  el.style.display = msg ? '' : 'none';
}

function setText(id: string, value: string | number): void {
  const el = $(id);
  if (el) el.textContent = String(value);
}

function setEngineStatus(value: string): void {
  setText('qb-status-engine', value);
}

function writeRunLog(lines: string[]): void {
  const log = $('qb-runlog');
  if (!log) return;
  log.innerHTML = lines.map(line => `<div>${escapeHtml(line)}</div>`).join('');
}

async function technicalLoadSequence(): Promise<void> {
  const steps = [
    'Parsing dataset...',
    'Cleaning missing values...',
    'Building design matrix...',
    'Estimating OLS coefficients...',
    'Computing diagnostics...',
  ];
  const emitted: string[] = [];
  setEngineStatus('RUNNING');
  for (const step of steps) {
    emitted.push(step);
    writeRunLog(emitted);
    await new Promise(resolve => setTimeout(resolve, 90));
  }
}

function parseDemoCsv(text: string): ParsedCSV {
  const [headerLine, ...dataLines] = text.trim().split(/\r?\n/);
  const headers = headerLine.split(',').map(header => header.trim());
  const rows = dataLines
    .filter(line => line.trim().length > 0)
    .map(line => {
      const values = line.split(',');
      return Object.fromEntries(
        headers.map((header, index) => {
          const raw = values[index]?.trim() ?? '';
          return [header, raw === '' ? null : Number(raw)];
        })
      );
    });

  return {
    headers,
    rows,
    numericColumns: headers.filter(header =>
      rows.length > 0 &&
      rows.every(row => {
        const raw = row[header];
        return raw !== null && raw !== '' && !isNaN(Number(raw)) && isFinite(Number(raw));
      })
    ),
  };
}

function setVariableSelection(yName: string, xNames: string[]): void {
  const yEl = $('qb-y') as HTMLSelectElement | null;
  if (yEl) yEl.value = yName;
  document.querySelectorAll<HTMLInputElement>('.qb-x-cb').forEach(cb => {
    cb.checked = xNames.includes(cb.value) && cb.value !== yName;
  });
}

function renderDemoInfo(demo: QuantDemoCase): void {
  const html = `
    <strong>${escapeHtml(demo.label)}</strong><br>
    ${escapeHtml(demo.description)}<br>
    <span>Y: <code>${escapeHtml(demo.yName)}</code> · X: ${demo.xNames.map(name => `<code>${escapeHtml(name)}</code>`).join(', ')}</span><br>
    <span>${escapeHtml(demo.restriction)}</span>`;
  const note = $('qb-demo-note');
  const restriction = $('qb-demo-restriction');
  if (note) note.innerHTML = html;
  if (restriction) {
    restriction.innerHTML = `<strong>Restriccion sugerida:</strong> ${escapeHtml(demo.restriction)}`;
    restriction.style.display = '';
  }
}

function clearDemoInfo(): void {
  const note = $('qb-demo-note');
  const restriction = $('qb-demo-restriction');
  if (note) {
    note.textContent = 'Elegi un ejemplo para precargar CSV, variable dependiente, regresores y restriccion sugerida.';
  }
  if (restriction) {
    restriction.innerHTML = '';
    restriction.style.display = 'none';
  }
}

async function loadDemoCase(id: string): Promise<void> {
  const demo = DEMO_CASES[id];
  if (!demo) return;
  showError('');
  setEngineStatus('PARSING');
  writeRunLog([`Loading demo: ${demo.label}`]);

  try {
    const response = await fetch(`/datasets/${encodeURIComponent(demo.file)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`No se pudo cargar ${demo.file}`);
    csvData = parseDemoCsv(await response.text());
    if (csvData.numericColumns.length < 2) {
      throw new Error('El CSV de ejemplo necesita al menos 2 columnas numericas.');
    }

    const fn = $('qb-filename');
    if (fn) fn.textContent = demo.file;
    setText('qb-status-dataset', demo.file);
    setText('qb-status-obs', csvData.rows.length);
    setText('qb-status-vars', csvData.numericColumns.length);
    setEngineStatus('READY');
    writeRunLog([
      `Demo mounted: ${demo.label}`,
      `Dataset: ${demo.file}`,
      `Suggested restriction: ${demo.restriction}`,
    ]);

    renderPreview(csvData);
    renderVarSelectors(csvData.numericColumns);
    setVariableSelection(demo.yName, demo.xNames);
    renderDemoInfo(demo);

    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results'), repair = $('qb-repair-log');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = '';
    if (results) results.style.display = 'none';
    if (repair) repair.style.display = 'none';
  } catch (err) {
    setEngineStatus('ERROR');
    showError(`Error al cargar demo: ${(err as Error).message}`);
  }
}

function chartTheme(title: string, xTitle: string, yTitle: string, legend = true): Record<string, unknown> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: legend,
        labels: { color: '#9aa7b7', font: { family: 'Consolas, monospace', size: 10 }, boxWidth: 10 },
      },
      title: {
        display: true,
        text: title,
        color: '#d8e2ee',
        font: { family: 'Consolas, monospace', size: 11, weight: '600' },
      },
    },
    scales: {
      x: {
        title: { display: true, text: xTitle, color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
        ticks: { color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
        grid: { color: 'rgba(125,136,150,.14)', lineWidth: 1 },
        border: { color: '#202a36' },
      },
      y: {
        title: { display: true, text: yTitle, color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
        ticks: { color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
        grid: { color: 'rgba(125,136,150,.14)', lineWidth: 1 },
        border: { color: '#202a36' },
      },
    },
  };
}

// ── Upload ────────────────────────────────────────────────────────────────────

async function onFileChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  showError('');
  clearDemoInfo();
  const fn = $('qb-filename');
  if (fn) fn.textContent = file.name;
  setText('qb-status-dataset', file.name);
  setEngineStatus('PARSING');
  writeRunLog(['Mounting CSV in data hold...']);

  try {
    csvData = await parseCSVFile(file);
    if (csvData.numericColumns.length < 2) {
      showError('El CSV necesita al menos 2 columnas numéricas.');
      return;
    }
    setText('qb-status-obs', csvData.rows.length);
    setText('qb-status-vars', csvData.numericColumns.length);
    setEngineStatus('READY');
    writeRunLog([
      `Dataset mounted: ${csvData.rows.length} observations`,
      `Numeric variables detected: ${csvData.numericColumns.length}`,
      'Regression engine ready.',
    ]);
    renderPreview(csvData);
    renderVarSelectors(csvData.numericColumns);
    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = '';
    if (results) results.style.display = 'none';
  } catch (err) {
    setEngineStatus('ERROR');
    showError(`Error al leer el archivo: ${(err as Error).message}`);
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────

function renderPreview({ headers, rows, numericColumns }: ParsedCSV): void {
  const preview = rows.slice(0, 6);
  const thead = `<tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
  const tbody = preview
    .map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h])}</td>`).join('')}</tr>`)
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
  if (yEl) yEl.innerHTML = cols.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if (xEl)
    xEl.innerHTML = cols
      .map(
        (c, i) =>
          `<label class="qb-x-check"><input type="checkbox" class="qb-x-cb" value="${escapeHtml(c)}" ${i > 0 ? 'checked' : ''}> ${escapeHtml(c)}</label>`
      )
      .join('');
}

// ── Run regression ────────────────────────────────────────────────────────────

async function onRun(): Promise<void> {
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

  try {
    await technicalLoadSequence();
    const analysis = runQuantAnalysis(csvData, yName, xNames);

    lastResult = analysis.result;
    lastCorr = analysis.corrMatrix;
    lastCorrCols = analysis.corrColumns;
    lastVIF = analysis.vifValues;
    lastLogit = analysis.logitResult;

    renderResults(
      analysis.result,
      analysis.dropped,
      analysis.corrMatrix,
      analysis.corrColumns,
      analysis.vifValues,
      {
        binary: analysis.binary,
        leaks: analysis.leaks,
        logitResult: analysis.logitResult,
      }
    );
    setText('qb-status-obs', analysis.result.nObs);
    setEngineStatus('COMPLETE');
    writeRunLog([
      'Parsing dataset... OK',
      'Cleaning missing values... OK',
      'Building design matrix... OK',
      'Estimating OLS coefficients... OK',
      'Computing diagnostics... OK',
    ]);
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
  } catch (err) {
    setEngineStatus('ERROR');
    showError(`Error en la regresión: ${(err as Error).message}`);
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

function renderResults(
  result: RegressionResult,
  dropped: number,
  corrMatrix: number[][],
  corrCols: string[],
  vifValues: number[],
  checks: {
    binary?: boolean;
    leaks?: LeakageSignal[];
    logitResult?: LogisticResult | null;
  } = {}
): void {
  const { binary = false, leaks = [], logitResult = null } = checks;
  renderBinaryWarn(binary, result.yName);
  renderLeakageWarn(leaks);
  const eq = $('qb-equation');
  if (eq) eq.textContent = result.equation;

  renderCoefTable(result);
  renderStatsTable(result, dropped);
  renderLogistic(logitResult);
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

function renderBinaryWarn(isBinary: boolean, yName: string): void {
  const el = $('qb-binary-warn');
  if (!el) return;
  if (!isBinary) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="qb-warn-yellow">
      <p><strong>Binary dependent variable detected: ${escapeHtml(yName)}</strong></p>
      <p>OLS is being used as a linear probability model. Predictions can fall outside [0, 1], residual variance is not constant, and coefficients should be read in approximate percentage-point terms.</p>
      <p>Logistic regression output is shown below the OLS coefficient ledger for comparison.</p>
    </div>`;
}

function renderLeakageWarn(leaks: LeakageSignal[]): void {
  const el = $('qb-leak-warn');
  if (!el) return;
  if (!leaks.length) {
    el.innerHTML = '';
    return;
  }
  const rows = leaks
    .map(
      leak =>
        `<p><strong>${escapeHtml(leak.name)}</strong> correlates ${leak.r.toFixed(4)} with the target (|r| = ${leak.abs.toFixed(4)}). Review whether this regressor is derived from the response.</p>`
    )
    .join('');
  el.innerHTML = `
    <div class="qb-warn-red">
      <p><strong>Possible data leakage detected</strong></p>
      ${rows}
      <p>Threshold: |r| >= 0.95.</p>
    </div>`;
}

function renderLogistic(res: LogisticResult | null): void {
  const wrap = $('qb-logit-wrap');
  const content = $('qb-logit-content');
  if (!wrap || !content) return;
  if (!res) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const f4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '-');
  const rows = res.featureNames
    .map(
      (name, index) =>
        `<tr><td>${escapeHtml(name)}</td><td>${f4(res.coefficients[index])}</td><td>${f4(res.oddsRatios[index])}</td></tr>`
    )
    .join('');

  content.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger">
        <thead><tr><th>Variable</th><th>Logit coef.</th><th>Odds ratio</th></tr></thead>
        <tbody>
          <tr><td>Intercept</td><td>${f4(res.intercept)}</td><td>${f4(Math.exp(res.intercept))}</td></tr>
          ${rows}
        </tbody>
      </table>
    </div>
    <table class="ledger qb-compact-ledger">
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>McFadden pseudo R²</td><td>${res.mcFaddenR2.toFixed(4)}</td></tr>
        <tr><td>Model log-likelihood</td><td>${res.llModel.toFixed(4)}</td></tr>
        <tr><td>Null log-likelihood</td><td>${res.llNull.toFixed(4)}</td></tr>
        <tr><td>In-sample accuracy</td><td>${(res.accuracy * 100).toFixed(1)}%</td></tr>
        <tr><td>Observations</td><td>${res.n}</td></tr>
      </tbody>
    </table>`;
}

function renderCoefTable(result: RegressionResult): void {
  const body = $('qb-coef-body');
  if (!body) return;
  const fmt6 = (n: number) => (isFinite(n) ? n.toFixed(6) : '—');
  const fmt4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '—');
  const fmtCI = ([lo, hi]: [number, number]) => `[${fmt4(lo)},&nbsp;${fmt4(hi)}]`;
  body.innerHTML = [
    `<tr>
      <td>Intercepto</td>
      <td>${fmt6(result.intercept)}</td>
      <td>${fmt6(result.stdErrors[0])}</td>
      <td>${fmt4(result.tStats[0])}</td>
      <td>${fmt4(result.pValues[0])}</td>
      <td style="white-space:nowrap">${fmtCI(result.ci95[0])}</td>
      <td>${significanceBadge(result.pValues[0])}</td>
    </tr>`,
    ...result.featureNames.map(
      (n, i) => `<tr>
        <td>${escapeHtml(n)}</td>
        <td>${fmt6(result.coefficients[i])}</td>
        <td>${fmt6(result.stdErrors[i + 1])}</td>
        <td>${fmt4(result.tStats[i + 1])}</td>
        <td>${fmt4(result.pValues[i + 1])}</td>
        <td style="white-space:nowrap">${fmtCI(result.ci95[i + 1])}</td>
        <td>${significanceBadge(result.pValues[i + 1])}</td>
      </tr>`
    ),
  ].join('');
}

function renderStatsTable(result: RegressionResult, dropped: number): void {
  const body = $('qb-stats-body');
  if (!body) return;
  const fmtF = (f: number) => !isFinite(f) ? '∞' : f.toFixed(4);
  body.innerHTML = `
    <tr><td>R²</td><td>${result.rSquared.toFixed(6)}</td></tr>
    <tr><td>R² ajustado</td><td>${result.adjustedRSquared.toFixed(6)}</td></tr>
    <tr><td>F-estadístico</td><td>${fmtF(result.fStat)}</td></tr>
    <tr><td>p(F)</td><td>${result.fPValue.toFixed(6)}</td></tr>
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
          backgroundColor: 'rgba(77, 227, 181, .58)',
          borderColor: '#4de3b5',
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        {
          label: 'Ajuste perfecto (y = x)',
          data: [{ x: minV - pad, y: minV - pad }, { x: maxV + pad, y: maxV + pad }],
          type: 'line',
          borderColor: '#f2c94c',
          borderDash: [6, 4],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: chartTheme(`${result.yName}: actual vs predicted`, `Actual (${result.yName})`, `Predicted (${result.yName})`),
  });
}

// ── Correlation matrix ────────────────────────────────────────────────────────

function renderCorrMatrix(corrMatrix: number[][], colNames: string[]): void {
  const wrap = $('qb-corr-wrap');
  if (!wrap || !corrMatrix || corrMatrix.length === 0) return;
  const k = colNames.length;
  const abbr = (n: string) => (n.length > 9 ? n.slice(0, 8) + '…' : n);

  let html = '<table class="ledger qb-corr-table"><thead><tr><th></th>';
  html += colNames.map(n => `<th title="${escapeHtml(n)}">${escapeHtml(abbr(n))}</th>`).join('');
  html += '</tr></thead><tbody>';
  for (let i = 0; i < k; i++) {
    html += `<tr><th title="${escapeHtml(colNames[i])}">${escapeHtml(abbr(colNames[i]))}</th>`;
    for (let j = 0; j < k; j++) {
      const r = corrMatrix[i][j];
      html += `<td class="${correlationClass(r, i === j)}">${r.toFixed(3)}</td>`;
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
    const vStr = !isFinite(v) ? '&gt;999' : v.toFixed(2);
    let cls: string, label: string;
    if (v >= 10) {
      cls = 'qb-vif-high'; label = '⚠ Severo';
      warnings.push(`"${xNames[i]}" (VIF ${!isFinite(v) ? '>999' : v.toFixed(1)}): multicolinealidad severa — los coeficientes pueden ser inestables.`);
    } else if (v >= 5) {
      cls = 'qb-vif-med'; label = '△ Precaución';
    } else {
      cls = 'qb-vif-ok'; label = '✓ Aceptable';
    }
    html += `<tr><td>${escapeHtml(xNames[i])}</td><td>${vStr}</td><td class="${cls}">${label}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  if (warnEl) {
    warnEl.innerHTML = warnings.length > 0
      ? `<div class="qb-warn">${warnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}</div>`
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
            backgroundColor: 'rgba(77, 227, 181, .52)',
            borderColor: '#4de3b5',
            pointRadius: 3,
          },
          {
            label: 'y=0',
            type: 'line',
            data: [{ x: minP, y: 0 }, { x: maxP, y: 0 }],
            borderColor: '#f2c94c',
            borderDash: [5, 3],
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: chartTheme('residuals vs fitted', 'Fitted value', 'Residual', false),
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
      data: { labels, datasets: [{ data: counts, backgroundColor: 'rgba(122, 167, 255, .42)', borderColor: '#7aa7ff', borderWidth: 1 }] },
      options: chartTheme('residual distribution', 'Residual', 'Frequency', false),
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
      head: [['Variable', 'Coef.', 'Err. Est.', 't-stat', 'p-valor', 'IC 95%', 'Signif.']],
      body: [
        ['Intercepto', lastResult.intercept.toFixed(6), lastResult.stdErrors[0].toFixed(6),
          isFinite(lastResult.tStats[0]) ? lastResult.tStats[0].toFixed(4) : '—',
          lastResult.pValues[0].toFixed(4),
          `[${lastResult.ci95[0][0].toFixed(4)}, ${lastResult.ci95[0][1].toFixed(4)}]`,
          significanceLabel(lastResult.pValues[0])],
        ...lastResult.featureNames.map((n, i) => [n,
          lastResult!.coefficients[i].toFixed(6),
          lastResult!.stdErrors[i + 1].toFixed(6),
          isFinite(lastResult!.tStats[i + 1]) ? lastResult!.tStats[i + 1].toFixed(4) : '—',
          lastResult!.pValues[i + 1].toFixed(4),
          `[${lastResult!.ci95[i + 1][0].toFixed(4)}, ${lastResult!.ci95[i + 1][1].toFixed(4)}]`,
          significanceLabel(lastResult!.pValues[i + 1])]),
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
        ['F-estadístico', isFinite(lastResult.fStat) ? lastResult.fStat.toFixed(4) : '∞'],
        ['p(F)', lastResult.fPValue.toFixed(6)],
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
        !isFinite(v) ? '>999' : v.toFixed(2),
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

// ── Auto-repair log ───────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  perfect_collinearity: 'COLINEALIDAD PERFECTA',
  singular_matrix:      'MATRIZ SINGULAR',
  high_vif:             'VIF ELEVADO',
  insufficient_obs:     'OBS. INSUFICIENTES',
};

function renderRepairLog(result: AutoRepairResult): void {
  const el = $('qb-repair-log');
  if (!el) return;

  if (!result.repaired) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  const removed = result.actions.map(a => `<code>${escapeHtml(a.removed)}</code>`).join(', ');
  const kept    = result.finalXNames.map(n => `<code>${escapeHtml(n)}</code>`).join(', ');

  const steps = result.actions.map((a, i) => {
    const valStr = a.valueBefore !== undefined
      ? ` — valor detectado: <strong>${isFinite(a.valueBefore) ? a.valueBefore.toFixed(3) : '>999'}</strong>`
      : '';
    return `
      <div class="qb-repair-step">
        <span class="qb-repair-badge qb-repair-${a.reason}">${REASON_LABEL[a.reason] ?? a.reason}</span>
        <div class="qb-repair-body">
          <strong>Paso ${i + 1}:</strong> eliminada <code>${escapeHtml(a.removed)}</code>${valStr}<br>
          <span class="muted">${escapeHtml(a.detail)}</span>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="qb-repair-log">
      <div class="qb-panel-head">
        <p class="qb-subtitle">Auto-repair log</p>
        <span>MODEL DOCTOR · ${result.actions.length} FIX${result.actions.length !== 1 ? 'ES' : ''}</span>
      </div>
      <p class="qb-repair-summary">
        Se detectaron <strong>${result.actions.length}</strong> problema(s) y se corrigieron automáticamente.<br>
        Variables originales: ${result.originalXNames.map(n => `<code>${escapeHtml(n)}</code>`).join(', ')}<br>
        Variables eliminadas: ${removed}<br>
        Modelo final con: ${kept}
      </p>
      <div class="qb-repair-steps">${steps}</div>
    </div>`;
  el.style.display = '';
}

// ── Auto-run handler ──────────────────────────────────────────────────────────

function onAutoRun(): void {
  if (!csvData) return;
  showError('');

  const yName  = ($('qb-y') as HTMLSelectElement)?.value ?? '';
  const xNames = Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v !== yName);

  if (xNames.length === 0) {
    showError('Seleccioná al menos una variable X distinta de Y.');
    return;
  }

  try {
    const analysis = autoRepairAndAnalyze(csvData, yName, xNames);

    lastResult    = analysis.result;
    lastCorr      = analysis.corrMatrix;
    lastCorrCols  = analysis.corrColumns;
    lastVIF       = analysis.vifValues;

    renderRepairLog(analysis);
    renderResults(
      analysis.result,
      analysis.dropped,
      analysis.corrMatrix,
      analysis.corrColumns,
      analysis.vifValues
    );

    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
  } catch (err) {
    showError(`Error en el análisis automático: ${(err as Error).message}`);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

function init(): void {
  $('qb-file')?.addEventListener('change', onFileChange as EventListener);
  document.querySelectorAll<HTMLButtonElement>('.qb-demo-btn').forEach(btn => {
    btn.addEventListener('click', () => loadDemoCase(btn.dataset.demo ?? ''));
  });
  $('qb-run')?.addEventListener('click', onRun);
  $('qb-auto-run')?.addEventListener('click', onAutoRun);
  $('qb-export-pdf')?.addEventListener('click', exportPDF);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
