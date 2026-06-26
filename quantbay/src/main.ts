import { parseCSVFile, type ParsedCSV } from './csvParser';
import type { RegressionResult } from './regression';
import { interpret } from './interpretation';
import type { RLSConstraint } from './rls';
import {
  AnalysisValidationError,
  type LeakageSignal,
  type LogisticResult,
} from './services/analysisService';
import { type AutoRepairResult } from './services/autoRepair';
import { runRegressionMode, runAutoRegressionMode } from './modes/regressionMode';
import {
  correlationClass,
  escapeHtml,
  significanceBadge,
} from './utils/format';
import { $, setEngineStatus, setMethodStatus, setText, showError, updateSidebarStep, writeRunLog } from './app/dom';
import { appState } from './app/state';
import { exportAnalysisCSV, exportAnalysisTXT, exportPDF } from './ui/exports';

declare const Chart: any;
// Max CSV dimensions accepted before analysis
const CSV_LIMITS = { maxRows: 5000, maxCols: 50, maxXVars: 20 };

interface QuantDemoCase {
  id: string;
  label: string;
  file: string;
  yName: string;
  xNames: string[];
  restriction: string;
  description: string;
  rlsConstraint?: RLSConstraint;
}

// R acts on [beta0, beta1, ..., betak]; q is the right-hand side of R*beta = q
const DEMO_CASES: Record<string, QuantDemoCase> = {
  'ols-simple': {
    id: 'ols-simple',
    label: 'OLS simple',
    file: '01_simple_linear.csv',
    yName: 'y',
    xNames: ['x'],
    restriction: 'Sin restricción: modelo OLS simple y = beta0 + beta1*x + error.',
    description: 'Relación lineal clara para verificar intercepto, pendiente, RSS y diagnósticos básicos.',
  },
  'rls-beta1-zero': {
    id: 'rls-beta1-zero',
    label: 'RLS beta1 = 0',
    file: '01_simple_linear.csv',
    yName: 'y',
    xNames: ['x'],
    restriction: 'Restricción RLS activa: beta1 = 0.',
    description: 'Usa el dataset simple para contrastar una pendiente nula contra el ajuste OLS completo.',
    rlsConstraint: { R: [[0, 1]], q: [0], label: 'beta1 = 0' },
  },
  'rls-beta1-beta2': {
    id: 'rls-beta1-beta2',
    label: 'RLS beta1 = beta2',
    file: '02_beta1_eq_beta2_approx_valid.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Restricción RLS activa: beta1 = beta2 (beta1 − beta2 = 0).',
    description: 'Caso donde beta1 y beta2 son aproximadamente iguales; la restricción no debería rechazarse a niveles usuales.',
    rlsConstraint: { R: [[0, 1, -1]], q: [0], label: 'beta1 = beta2 (beta1 − beta2 = 0)' },
  },
  'rls-sum-one': {
    id: 'rls-sum-one',
    label: 'RLS beta1 + beta2 = 1',
    file: '04_beta1_plus_beta2_eq_1.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Restricción RLS activa: beta1 + beta2 = 1.',
    description: 'Dataset para comprobar una restricción lineal sobre la suma de coeficientes.',
    rlsConstraint: { R: [[0, 1, 1]], q: [1], label: 'beta1 + beta2 = 1' },
  },
  singular: {
    id: 'singular',
    label: 'Caso singular',
    file: '05_perfect_collinearity.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Sin restricción RLS: debe detectarse colinealidad perfecta (x2 = 2*x1) antes de estimar.',
    description: 'Caso de colinealidad perfecta: la matriz de diseño no tiene rango completo y el modelo debe avisar antes de estimar.',
  },
};

function checkCSVLimits(data: ParsedCSV, xNames: string[]): string | null {
  if (data.rows.length > CSV_LIMITS.maxRows)
    return `El CSV tiene ${data.rows.length} filas. El máximo soportado es ${CSV_LIMITS.maxRows}. Reducí el dataset antes de calcular.`;
  if (data.headers.length > CSV_LIMITS.maxCols)
    return `El CSV tiene ${data.headers.length} columnas. El máximo soportado es ${CSV_LIMITS.maxCols}.`;
  if (xNames.length > CSV_LIMITS.maxXVars)
    return `Seleccionaste ${xNames.length} variables X. El máximo es ${CSV_LIMITS.maxXVars}. Reducí la selección.`;
  return null;
}

function formatRegressionError(err: unknown): string {
  if (err instanceof AnalysisValidationError) {
    const lines = err.issues.map(issue => {
      const cols = issue.columns.map(col => `"${col}"`).join(', ');
      switch (issue.type) {
        case 'missing_values':
          return `Hay celdas vacias en ${cols}. Completa esos datos o filtra esas filas antes de calcular.`;
        case 'invalid_numeric':
          return `Hay valores no numericos en ${cols}. Revisa texto, simbolos, separadores decimales o celdas mezcladas con palabras.`;
        case 'constant_column':
          return `${cols} no cambia entre filas. Una variable constante no ayuda a explicar Y; usa otra variable o agrega datos con variacion.`;
        case 'duplicate_column':
          return `${cols} contienen la misma informacion fila por fila. Deja solo una de esas columnas.`;
        case 'collinearity':
          return `${cols} estan demasiado relacionadas entre si. El modelo no puede separar sus efectos; quita una variable o transforma los datos.`;
        default:
          return issue.message;
      }
    });
    return [
      'No se pudo calcular la regresión.',
      ...lines.map(line => `- ${line}`),
      'ChartBay no cambió ni eliminó datos automáticamente.',
    ].join('\n');
  }

  const message = (err as Error).message ?? String(err);
  if (/Observaciones insuficientes/i.test(message)) {
    return `${message}\nSugerencia: usá menos variables X o cargá un dataset con más filas numéricas completas.`;
  }
  if (/singular|colineal|rango|rank/i.test(message)) {
    return `${message}\nSugerencia: quita una variable repetida o una variable que sea combinacion de otras.`;
  }
  return message;
}

async function technicalLoadSequence(): Promise<void> {
  const steps = [
    'Leyendo datos...',
    'Filtrando valores faltantes...',
    'Construyendo matriz de diseño...',
    'Estimando coeficientes OLS...',
    'Calculando diagnósticos...',
  ];
  const emitted: string[] = [];
  setEngineStatus('CALCULANDO');
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
        return raw !== null && !isNaN(Number(raw)) && isFinite(Number(raw));
      })
    ),
  };
}

function applyYIndicators(yName: string): void {
  document.querySelectorAll<HTMLInputElement>('.qb-x-cb').forEach(cb => {
    const isY = cb.value === yName;
    cb.disabled = isY;
    if (isY) cb.checked = false;
    const label = cb.closest<HTMLElement>('.qb-x-check');
    if (label) {
      label.style.opacity = isY ? '0.4' : '';
      const badge = label.querySelector<HTMLElement>('.qb-y-badge');
      if (badge) badge.style.display = isY ? '' : 'none';
    }
  });
}

function setVariableSelection(yName: string, xNames: string[]): void {
  const yEl = $('qb-y') as HTMLSelectElement | null;
  if (yEl) yEl.value = yName;
  document.querySelectorAll<HTMLInputElement>('.qb-x-cb').forEach(cb => {
    cb.checked = xNames.includes(cb.value) && cb.value !== yName;
  });
  applyYIndicators(yName);
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
    restriction.innerHTML = `<strong>Restricción sugerida:</strong> ${escapeHtml(demo.restriction)}`;
    restriction.style.display = '';
  }
}

function clearDemoInfo(): void {
  const note = $('qb-demo-note');
  const restriction = $('qb-demo-restriction');
  if (note) {
    note.textContent = 'Elegí un ejemplo para precargar CSV, variable dependiente, regresores y restricción sugerida.';
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
  appState.activeDemoId = id;
  setEngineStatus('LEYENDO');
  writeRunLog([`Cargando demo: ${demo.label}`]);

  try {
    const response = await fetch(`/datasets/${encodeURIComponent(demo.file)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`No se pudo cargar ${demo.file}`);
    appState.csvData = parseDemoCsv(await response.text());
    if (appState.csvData.numericColumns.length < 2) {
      throw new Error('El CSV de ejemplo necesita al menos 2 columnas numéricas.');
    }

    const fn = $('qb-filename');
    if (fn) fn.textContent = demo.file;
    setText('qb-status-dataset', demo.file);
    setText('qb-status-obs', appState.csvData.rows.length);
    setText('qb-status-vars', appState.csvData.numericColumns.length);
    setEngineStatus('LISTO');
    writeRunLog([
      `Demo cargado: ${demo.label}`,
      `Archivo: ${demo.file}`,
      `Restricción sugerida: ${demo.restriction}`,
    ]);

    renderPreview(appState.csvData);
    renderVarSelectors(appState.csvData.numericColumns);
    setVariableSelection(demo.yName, demo.xNames);
    renderDemoInfo(demo);

    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results'), repair = $('qb-repair-log');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = '';
    if (results) results.style.display = 'none';
    if (repair) repair.style.display = 'none';

    await onRun();
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

const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2 MB — checked before PapaParse so a huge file never freezes the browser

async function onFileChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  if (file.size > MAX_CSV_BYTES) {
    showError(
      `El archivo pesa ${(file.size / 1024 / 1024).toFixed(1)} MB. ` +
      `El máximo soportado es 2 MB. Reducí el CSV antes de cargarlo.`
    );
    return;
  }

  showError('');
  appState.activeDemoId = null;
  clearDemoInfo();
  const fn = $('qb-filename');
  if (fn) fn.textContent = file.name;
  setText('qb-status-dataset', file.name);
  setEngineStatus('LEYENDO');
  writeRunLog(['Leyendo archivo CSV...']);

  try {
    appState.csvData = await parseCSVFile(file);
    if (appState.csvData.numericColumns.length < 2) {
      showError('El CSV necesita al menos 2 columnas numéricas.');
      return;
    }
    setText('qb-status-obs', appState.csvData.rows.length);
    setText('qb-status-vars', appState.csvData.numericColumns.length);
    setEngineStatus('LISTO');
    writeRunLog([
      `Dataset cargado: ${appState.csvData.rows.length} observaciones`,
      `Variables numéricas detectadas: ${appState.csvData.numericColumns.length}`,
      'Motor de regresión listo.',
    ]);
    renderPreview(appState.csvData);
    renderVarSelectors(appState.csvData.numericColumns);
    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = '';
    if (results) results.style.display = 'none';
    updateSidebarStep(2);
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
  const defaultY = cols[0] ?? '';
  if (xEl)
    xEl.innerHTML = cols
      .map((c, i) => {
        const isY = c === defaultY;
        return `<label class="qb-x-check" style="${isY ? 'opacity:0.4' : ''}"><input type="checkbox" class="qb-x-cb" value="${escapeHtml(c)}" ${i > 0 ? 'checked' : ''} ${isY ? 'disabled title="Ya seleccionada como variable Y"' : ''}> ${escapeHtml(c)}<span class="qb-y-badge"${isY ? '' : ' style="display:none"'}> (Y)</span></label>`;
      })
      .join('');
}

// ── Run regression ────────────────────────────────────────────────────────────

async function onRun(): Promise<void> {
  if (!appState.csvData) return;
  showError('');
  const yName = ($('qb-y') as HTMLSelectElement)?.value ?? '';
  const xNames = Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v !== yName);

  if (xNames.length === 0) {
    showError('Seleccioná al menos una variable X distinta de Y.');
    return;
  }

  const limitErr = checkCSVLimits(appState.csvData, xNames);
  if (limitErr) { showError(limitErr); return; }

  const rlsConstraint = appState.activeDemoId ? DEMO_CASES[appState.activeDemoId]?.rlsConstraint : undefined;

  try {
    await technicalLoadSequence();
    const output = runRegressionMode(appState.csvData, yName, xNames, rlsConstraint);

    appState.lastResult = output.result;
    appState.lastCorr = output.corrMatrix;
    appState.lastCorrCols = output.corrColumns;
    appState.lastVIF = output.vifValues;
    appState.lastLogit = output.logitResult;

    setMethodStatus(output.method);
    renderResults(
      output.result,
      output.dropped,
      output.corrMatrix,
      output.corrColumns,
      output.vifValues,
      {
        binary: output.binary,
        leaks: output.leaks,
        logitResult: output.logitResult,
      }
    );
    setText('qb-status-obs', output.result.nObs);
    setEngineStatus('COMPLETADO');
    writeRunLog(output.logEntries);
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
    updateSidebarStep(3);
  } catch (err) {
    setEngineStatus('ERROR');
    showError(formatRegressionError(err));
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
  appState.lastDropped = dropped;
  renderBinaryWarn(binary, result.yName);
  renderLeakageWarn(leaks);
  const eq = $('qb-equation');
  if (eq) eq.textContent = result.equation;

  renderCoefTable(result);
  renderStatsTable(result, dropped);
  renderRLSPanel(result);
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
      <p><strong>Variable dependiente binaria detectada: ${escapeHtml(yName)}</strong></p>
      <p>Se está usando OLS como modelo de probabilidad lineal. Las predicciones pueden quedar fuera del rango [0,1], la varianza residual no es constante y los coeficientes se interpretan como cambios aproximados en puntos porcentuales.</p>
      <p>Se muestra una regresión logística a continuación para comparar.</p>
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
        `<p><strong>${escapeHtml(leak.name)}</strong>: correlación ${leak.r.toFixed(4)} con la variable dependiente (|r| = ${leak.abs.toFixed(4)}).</p>`
    )
    .join('');

  if (appState.activeDemoId) {
    // Demo datasets are intentionally built with strong linear relationships
    el.innerHTML = `
      <div class="qb-warn-yellow">
        <p><strong>Alta correlación detectada</strong></p>
        ${rows}
        <p>Este demo está diseñado para mostrar una relación lineal fuerte. En datos reales, revisá que los predictores no se deriven de la variable dependiente antes de usar el modelo. Umbral: |r| ≥ 0.95.</p>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="qb-warn-red">
        <p><strong>Posible data leakage detectado</strong></p>
        ${rows}
        <p>Revisá si este predictor se deriva de la respuesta o fue construido a partir de ella. Umbral: |r| ≥ 0.95.</p>
      </div>`;
  }
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
        <thead><tr><th>Variable</th><th>Coef. logístico</th><th>Odds ratio</th></tr></thead>
        <tbody>
          <tr><td>Intercepto</td><td>${f4(res.intercept)}</td><td>${f4(Math.exp(res.intercept))}</td></tr>
          ${rows}
        </tbody>
      </table>
    </div>
    <table class="ledger qb-compact-ledger">
      <thead><tr><th>Métrica</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td>McFadden pseudo R²</td><td>${res.mcFaddenR2.toFixed(4)}</td></tr>
        <tr><td>Log-verosimilitud del modelo</td><td>${res.llModel.toFixed(4)}</td></tr>
        <tr><td>Log-verosimilitud nula</td><td>${res.llNull.toFixed(4)}</td></tr>
        <tr><td>Precisión en muestra</td><td>${(res.accuracy * 100).toFixed(1)}%</td></tr>
        <tr><td>Observaciones</td><td>${res.n}</td></tr>
      </tbody>
    </table>`;
}

function renderCoefTable(result: RegressionResult): void {
  const body = $('qb-coef-body');
  if (!body) return;
  const fmt6 = (n: number) => (isFinite(n) ? n.toFixed(6) : '—');
  const fmt4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '—');
  const fmtCI = ([lo, hi]: [number, number]) => `[${fmt4(lo)},&nbsp;${fmt4(hi)}]`;
  const noInf = result.restrictedInferenceAvailable === false;
  const nd = '<span style="opacity:0.4;font-style:italic">N/D</span>';
  body.innerHTML = [
    `<tr>
      <td>Intercepto</td>
      <td>${fmt6(result.intercept)}</td>
      <td>${noInf ? nd : fmt6(result.stdErrors[0])}</td>
      <td>${noInf ? nd : fmt4(result.tStats[0])}</td>
      <td>${noInf ? nd : fmt4(result.pValues[0])}</td>
      <td style="white-space:nowrap">${noInf ? nd : fmtCI(result.ci95[0])}</td>
      <td>${noInf ? nd : significanceBadge(result.pValues[0])}</td>
    </tr>`,
    ...result.featureNames.map(
      (n, i) => `<tr>
        <td>${escapeHtml(n)}</td>
        <td>${fmt6(result.coefficients[i])}</td>
        <td>${noInf ? nd : fmt6(result.stdErrors[i + 1])}</td>
        <td>${noInf ? nd : fmt4(result.tStats[i + 1])}</td>
        <td>${noInf ? nd : fmt4(result.pValues[i + 1])}</td>
        <td style="white-space:nowrap">${noInf ? nd : fmtCI(result.ci95[i + 1])}</td>
        <td>${noInf ? nd : significanceBadge(result.pValues[i + 1])}</td>
      </tr>`
    ),
  ].join('');
}

function renderStatsTable(result: RegressionResult, dropped: number): void {
  const body = $('qb-stats-body');
  if (!body) return;
  const fmtF = (f: number) => !isFinite(f) ? '∞' : f.toFixed(4);
  body.innerHTML = `
    <tr><td>Método</td><td>${result.method === 'RLS' ? 'RLS' : 'OLS'}</td></tr>
    <tr><td>R²</td><td>${result.rSquared.toFixed(4)}</td></tr>
    <tr><td>R² ajustado</td><td>${result.adjustedRSquared.toFixed(4)}</td></tr>
    <tr><td>F-estadístico</td><td>${fmtF(result.fStat)}</td></tr>
    <tr><td>p(F)</td><td>${result.fPValue.toFixed(4)}</td></tr>
    <tr><td>Observaciones (n)</td><td>${result.nObs}</td></tr>
    <tr><td>Variables (k)</td><td>${result.nFeatures}</td></tr>
    <tr><td>Grados de libertad</td><td>${result.df}</td></tr>
    <tr><td>σ² (var. residual)</td><td>${result.sigma2.toFixed(4)}</td></tr>
    ${dropped > 0 ? `<tr><td>Filas omitidas (NA)</td><td>${dropped}</td></tr>` : ''}`;
}

function renderRLSPanel(result: RegressionResult): void {
  const panel = $('qb-rls-panel');
  const content = $('qb-rls-content');
  if (!panel || !content) return;

  if (result.method !== 'RLS') {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  const f4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '—');
  const pVal = result.fPValueConstraint ?? 1;
  const rejected = pVal < 0.05;
  const verdict = rejected
    ? `Restricción <strong>rechazada</strong> (p = ${f4(pVal)} &lt; 0.05): los datos no son estadísticamente compatibles con la restricción al 5%.`
    : `Restricción <strong>no rechazada</strong> (p = ${f4(pVal)} ≥ 0.05): los datos son estadísticamente compatibles con la restricción al 5%.`;

  content.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger">
        <thead><tr><th>Indicador</th><th>Valor</th></tr></thead>
        <tbody>
          <tr><td>Restricción aplicada</td><td><strong>${escapeHtml(result.rlsConstraint ?? '')}</strong></td></tr>
          <tr><td>RSS sin restricción (OLS)</td><td>${(result.rssOLS ?? 0).toFixed(6)}</td></tr>
          <tr><td>RSS con restricción (RLS)</td><td>${(result.rssRLS ?? 0).toFixed(6)}</td></tr>
          <tr><td>F-test restricción</td><td>${f4(result.fStatConstraint ?? 0)}</td></tr>
          <tr><td>p-valor (F-test)</td><td>${f4(pVal)}</td></tr>
          <tr><td>Restricciones (J)</td><td>${result.jConstraints ?? 1}</td></tr>
        </tbody>
      </table>
    </div>
    <p class="qb-interp" style="margin-top:8px">${verdict}</p>`;
}

function renderChart(result: RegressionResult): void {
  const canvas = $('qb-chart') as HTMLCanvasElement | null;
  if (appState.activeChart) { appState.activeChart.destroy(); appState.activeChart = null; }
  if (typeof Chart === 'undefined' || !canvas) return;

  const actual = result.predictions.map((p, i) => p + result.residuals[i]);
  const allV = [...actual, ...result.predictions];
  const minV = Math.min(...allV), maxV = Math.max(...allV);
  const pad = (maxV - minV) * 0.05 || 1;

  appState.activeChart = new Chart(canvas, {
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
    options: chartTheme(`${result.yName}: actual vs predicho`, `Actual (${result.yName})`, `Predicho (${result.yName})`),
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
    if (appState.residFittedChart) { appState.residFittedChart.destroy(); appState.residFittedChart = null; }
    const minP = Math.min(...result.predictions);
    const maxP = Math.max(...result.predictions);
    appState.residFittedChart = new Chart(rfCanvas, {
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
      options: chartTheme('residuos vs ajustados', 'Valor ajustado', 'Residuo', false),
    });
  }

  const histCanvas = $('qb-resid-hist') as HTMLCanvasElement | null;
  if (histCanvas) {
    if (appState.residHistChart) { appState.residHistChart.destroy(); appState.residHistChart = null; }
    const resids = result.residuals;
    const minR = Math.min(...resids), maxR = Math.max(...resids);
    const bins = Math.min(10, Math.max(3, Math.floor(Math.sqrt(resids.length))));
    const bw = (maxR - minR) / bins || 1;
    const counts = new Array(bins).fill(0);
    resids.forEach(r => { const idx = Math.min(Math.floor((r - minR) / bw), bins - 1); counts[idx]++; });
    const labels = Array.from({ length: bins }, (_, i) => (minR + (i + 0.5) * bw).toFixed(2));
    appState.residHistChart = new Chart(histCanvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: counts, backgroundColor: 'rgba(122, 167, 255, .42)', borderColor: '#7aa7ff', borderWidth: 1 }] },
      options: chartTheme('distribución de residuos', 'Residuo', 'Frecuencia', false),
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

// ── Auto-repair log ───────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  perfect_collinearity: 'COLINEALIDAD PERFECTA',
  singular_matrix:      'MATRIZ SINGULAR',
  high_vif:             'VIF ELEVADO',
  insufficient_obs:     'OBS. INSUFICIENTES',
};

function renderRepairLog(result: AutoRepairResult, rlsFallbackNote = ''): void {
  const el = $('qb-repair-log');
  if (!el) return;

  if (!result.repaired && !rlsFallbackNote) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  const rlsNoteHtml = rlsFallbackNote
    ? `<div class="qb-warn-yellow" style="margin-top:8px"><strong>ℹ Método:</strong> ${escapeHtml(rlsFallbackNote)}</div>`
    : '';

  if (!result.repaired) {
    el.innerHTML = `<div class="qb-repair-log">${rlsNoteHtml}</div>`;
    el.style.display = '';
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
        <p class="qb-subtitle">Reparación automática</p>
        <span>DOCTOR DEL MODELO · ${result.actions.length} CORRECCI${result.actions.length !== 1 ? 'ONES' : 'ÓN'}</span>
      </div>
      <div class="qb-warn-yellow" style="margin:8px 0">
        <strong>⚠ El modelo que se calculó es diferente al que solicitaste.</strong><br>
        Modelo solicitado: ${result.originalXNames.map(n => `<code>${escapeHtml(n)}</code>`).join(', ')}<br>
        Variables eliminadas automáticamente: ${removed}<br>
        Modelo final estimado con: ${kept}
      </div>
      <div class="qb-repair-steps">${steps}</div>
      ${rlsNoteHtml}
    </div>`;
  el.style.display = '';
}

// ── Auto-run handler ──────────────────────────────────────────────────────────

function onAutoRun(): void {
  if (!appState.csvData) return;
  showError('');

  const yName  = ($('qb-y') as HTMLSelectElement)?.value ?? '';
  const xNames = Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v !== yName);

  if (xNames.length === 0) {
    showError('Seleccioná al menos una variable X distinta de Y.');
    return;
  }

  const rlsConstraint = appState.activeDemoId ? DEMO_CASES[appState.activeDemoId]?.rlsConstraint : undefined;

  try {
    const output = runAutoRegressionMode(appState.csvData, yName, xNames, rlsConstraint);

    appState.lastResult   = output.result;
    appState.lastCorr     = output.corrMatrix;
    appState.lastCorrCols = output.corrColumns;
    appState.lastVIF      = output.vifValues;
    appState.lastLogit    = null;

    setMethodStatus(output.method);
    renderRepairLog(output.repairResult, output.rlsFallbackNote);
    renderResults(
      output.result,
      output.dropped,
      output.corrMatrix,
      output.corrColumns,
      output.vifValues
    );

    setEngineStatus('COMPLETADO');
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
  } catch (err) {
    showError(formatRegressionError(err));
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
  $('qb-export-csv')?.addEventListener('click', exportAnalysisCSV);
  $('qb-export-txt')?.addEventListener('click', exportAnalysisTXT);

  $('qb-y')?.addEventListener('change', () => {
    applyYIndicators(($('qb-y') as HTMLSelectElement)?.value ?? '');
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
