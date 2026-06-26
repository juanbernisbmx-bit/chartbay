import { parseCSVFile, getValidRows, type ParsedCSV } from './csvParser';
import type { RegressionResult } from './regression';
import { interpret } from './interpretation';
import { runRLS, type RLSConstraint } from './rls';
import {
  AnalysisValidationError,
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
let lastDropped = 0;
let activeDemoId: string | null = null;

// Max CSV dimensions accepted before analysis
const CSV_LIMITS = { maxRows: 5000, maxCols: 50, maxXVars: 20 };

const $ = (id: string): HTMLElement | null => document.getElementById(id);

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
    restriction: 'Sin restriccion: modelo OLS simple y = beta0 + beta1*x + error.',
    description: 'Relacion lineal clara para verificar intercepto, pendiente, RSS y diagnosticos basicos.',
  },
  'rls-beta1-zero': {
    id: 'rls-beta1-zero',
    label: 'RLS beta1 = 0',
    file: '01_simple_linear.csv',
    yName: 'y',
    xNames: ['x'],
    restriction: 'Restriccion RLS activa: beta1 = 0.',
    description: 'Usa el dataset simple para contrastar una pendiente nula contra el ajuste OLS completo.',
    rlsConstraint: { R: [[0, 1]], q: [0], label: 'beta1 = 0' },
  },
  'rls-beta1-beta2': {
    id: 'rls-beta1-beta2',
    label: 'RLS beta1 = beta2',
    file: '02_beta1_eq_beta2_approx_valid.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Restriccion RLS activa: beta1 = beta2 (beta1 - beta2 = 0).',
    description: 'Caso donde beta1 y beta2 son aproximadamente iguales; la restriccion no deberia rechazarse a niveles usuales.',
    rlsConstraint: { R: [[0, 1, -1]], q: [0], label: 'beta1 = beta2 (beta1 − beta2 = 0)' },
  },
  'rls-sum-one': {
    id: 'rls-sum-one',
    label: 'RLS beta1 + beta2 = 1',
    file: '04_beta1_plus_beta2_eq_1.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Restriccion RLS activa: beta1 + beta2 = 1.',
    description: 'Dataset para comprobar una restriccion lineal sobre la suma de coeficientes.',
    rlsConstraint: { R: [[0, 1, 1]], q: [1], label: 'beta1 + beta2 = 1' },
  },
  singular: {
    id: 'singular',
    label: 'Caso singular',
    file: '05_perfect_collinearity.csv',
    yName: 'y',
    xNames: ['x1', 'x2'],
    restriction: 'Sin restriccion RLS: debe detectarse colinealidad perfecta (x2 = 2*x1) antes de estimar.',
    description: 'Caso de colinealidad perfecta: la matriz de diseno no tiene rango completo y el modelo debe avisar antes de estimar.',
  },
};

function showError(msg: string): void {
  const el = $('qb-error');
  if (!el) return;
  el.innerHTML = msg ? escapeHtml(msg).replace(/\n/g, '<br>') : '';
  el.style.display = msg ? '' : 'none';
}

function setMethodStatus(method: string): void {
  setText('qb-status-method', method);
  const badge = document.querySelector<HTMLElement>('#qb-results .qb-panel-head span');
  if (badge) badge.textContent = method;
}

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
      'No se pudo calcular la regresion.',
      ...lines.map(line => `- ${line}`),
      'Chart Bay no cambio ni elimino datos automaticamente.',
    ].join('\n');
  }

  const message = (err as Error).message ?? String(err);
  if (/Observaciones insuficientes/i.test(message)) {
    return `${message}\nSugerencia: usa menos variables X o carga un dataset con mas filas numericas completas.`;
  }
  if (/singular|colineal|rango|rank/i.test(message)) {
    return `${message}\nSugerencia: quita una variable repetida o una variable que sea combinacion de otras.`;
  }
  return message;
}

function updateSidebarStep(stepNum: number): void {
  document.querySelectorAll<HTMLAnchorElement>('.qb-sidebar a').forEach((link, i) => {
    link.style.fontWeight = (i + 1 === stepNum) ? '700' : '';
    link.style.opacity = (i + 1 <= stepNum) ? '1' : '0.45';
  });
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
  activeDemoId = id;
  setEngineStatus('LEYENDO');
  writeRunLog([`Cargando demo: ${demo.label}`]);

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
    setEngineStatus('LISTO');
    writeRunLog([
      `Demo cargado: ${demo.label}`,
      `Archivo: ${demo.file}`,
      `Restricción sugerida: ${demo.restriction}`,
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
  activeDemoId = null;
  clearDemoInfo();
  const fn = $('qb-filename');
  if (fn) fn.textContent = file.name;
  setText('qb-status-dataset', file.name);
  setEngineStatus('LEYENDO');
  writeRunLog(['Leyendo archivo CSV...']);

  try {
    csvData = await parseCSVFile(file);
    if (csvData.numericColumns.length < 2) {
      showError('El CSV necesita al menos 2 columnas numéricas.');
      return;
    }
    setText('qb-status-obs', csvData.rows.length);
    setText('qb-status-vars', csvData.numericColumns.length);
    setEngineStatus('LISTO');
    writeRunLog([
      `Dataset cargado: ${csvData.rows.length} observaciones`,
      `Variables numéricas detectadas: ${csvData.numericColumns.length}`,
      'Motor de regresión listo.',
    ]);
    renderPreview(csvData);
    renderVarSelectors(csvData.numericColumns);
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
      .map(
        (c, i) =>
          `<label class="qb-x-check" style="${c === defaultY ? 'opacity:0.4' : ''}"><input type="checkbox" class="qb-x-cb" value="${escapeHtml(c)}" ${i > 0 ? 'checked' : ''} ${c === defaultY ? 'disabled title="Ya es la variable Y"' : ''}> ${escapeHtml(c)}</label>`
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

  const limitErr = checkCSVLimits(csvData, xNames);
  if (limitErr) { showError(limitErr); return; }

  try {
    await technicalLoadSequence();
    const analysis = runQuantAnalysis(csvData, yName, xNames);

    // Apply RLS if the active demo has a structured constraint
    const demo = activeDemoId ? DEMO_CASES[activeDemoId] : null;
    const rlsConstraint = demo?.rlsConstraint;
    let finalResult = analysis.result;
    const logEntries = [
      'Leyendo datos... OK',
      'Filtrando valores faltantes... OK',
      'Construyendo matriz de diseño... OK',
      'Estimando coeficientes OLS... OK',
    ];

    if (rlsConstraint) {
      try {
        const { X: Xrls, y: yrls } = getValidRows(csvData.rows, yName, xNames);
        finalResult = runRLS({ X: Xrls, y: yrls, featureNames: xNames, yName }, rlsConstraint);
        logEntries.push(`Aplicando restricción RLS: ${rlsConstraint.label}... OK`);
        setMethodStatus('RLS');
      } catch (rlsErr) {
        logEntries.push(`Restricción RLS no pudo aplicarse: ${(rlsErr as Error).message}`);
        setMethodStatus('OLS');
      }
    } else {
      setMethodStatus('OLS');
    }
    logEntries.push('Calculando diagnósticos... OK');

    lastResult = finalResult;
    lastCorr = analysis.corrMatrix;
    lastCorrCols = analysis.corrColumns;
    lastVIF = analysis.vifValues;
    lastLogit = analysis.logitResult;

    renderResults(
      finalResult,
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
    setText('qb-status-obs', finalResult.nObs);
    setEngineStatus('COMPLETADO');
    writeRunLog(logEntries);
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
  lastDropped = dropped;
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
        `<p><strong>${escapeHtml(leak.name)}</strong> tiene correlación ${leak.r.toFixed(4)} con la variable dependiente (|r| = ${leak.abs.toFixed(4)}). Revisá si este predictor se deriva de la respuesta.</p>`
    )
    .join('');
  el.innerHTML = `
    <div class="qb-warn-red">
      <p><strong>Posible data leakage detectado</strong></p>
      ${rows}
      <p>Umbral: |r| ≥ 0.95.</p>
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
      options: chartTheme('residuos vs ajustados', 'Valor ajustado', 'Residuo', false),
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

// ── PDF Export ────────────────────────────────────────────────────────────────

function residualSumSquares(result: RegressionResult): number {
  return result.residuals.reduce((sum, residual) => sum + residual ** 2, 0);
}

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value: string | number): string {
  const text = String(value);
  // Prefix formula-injection characters with a single quote so Excel/Sheets
  // treats the cell as text instead of executing a formula.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function exportAnalysisCSV(): void {
  if (!lastResult) {
    showError('Primero ejecutá una regresión para poder exportar.');
    return;
  }

  const result = lastResult;
  const conclusion = interpret(result);
  const noInfCSV = result.restrictedInferenceAvailable === false;
  const infVal = (v: number): string | number => noInfCSV ? 'N/D' : v;
  const rows: Array<Array<string | number>> = [
    ['section', 'metric', 'variable', 'value'],
    ['model', 'dependent_variable', '', result.yName],
    ['model', 'method', '', result.method ?? 'OLS'],
    ['model', 'r_squared', '', result.rSquared],
    ['model', 'adjusted_r_squared', '', result.adjustedRSquared],
    ['model', 'rss', '', residualSumSquares(result)],
    ['model', 'f_stat', '', result.fStat],
    ['model', 'f_p_value', '', result.fPValue],
    ['model', 'observations', '', result.nObs],
    ['model', 'features', '', result.nFeatures],
    ['model', 'degrees_of_freedom', '', result.df],
    ['model', 'dropped_rows', '', lastDropped],
    ...(noInfCSV ? [['note', 'inference', '', 'Inferencia individual no disponible para RLS sin matriz de covarianza restringida']] as Array<Array<string | number>> : []),
    ['coefficient', 'estimate', 'intercept', result.intercept],
    ['coefficient', 'std_error', 'intercept', infVal(result.stdErrors[0])],
    ['coefficient', 't_stat', 'intercept', infVal(result.tStats[0])],
    ['coefficient', 'p_value', 'intercept', infVal(result.pValues[0])],
    ...result.featureNames.flatMap((name, index) => [
      ['coefficient', 'estimate', name, result.coefficients[index]],
      ['coefficient', 'std_error', name, infVal(result.stdErrors[index + 1])],
      ['coefficient', 't_stat', name, infVal(result.tStats[index + 1])],
      ['coefficient', 'p_value', name, infVal(result.pValues[index + 1])],
    ] as Array<Array<string | number>>),
    ['conclusion', 'text', '', conclusion],
  ];

  downloadTextFile(
    'quantbay_resultados.csv',
    rows.map(row => row.map(csvCell).join(',')).join('\n'),
    'text/csv'
  );
}

function exportAnalysisTXT(): void {
  if (!lastResult) {
    showError('Primero ejecutá una regresión para poder exportar.');
    return;
  }

  const result = lastResult;
  const noInfTxt = result.restrictedInferenceAvailable === false;
  const fmtI = (v: number): string => noInfTxt ? 'N/D' : v.toFixed(6);
  const lines = [
    'Quant Bay - Resultados del analisis',
    '',
    `Variable dependiente: ${result.yName}`,
    `Metodo: ${result.method ?? 'OLS'}`,
    `Ecuacion: ${result.equation}`,
    '',
    ...(noInfTxt ? ['NOTA: Inferencia individual (Err. Est., t-stat, p-value) no disponible para RLS sin matriz de covarianza restringida.', ''] : []),
    'Coeficientes',
    'Variable\tCoeficiente\tError estandar\tt-stat\tp-value',
    `Intercepto\t${result.intercept.toFixed(6)}\t${fmtI(result.stdErrors[0])}\t${fmtI(result.tStats[0])}\t${fmtI(result.pValues[0])}`,
    ...result.featureNames.map((name, index) =>
      `${name}\t${result.coefficients[index].toFixed(6)}\t${fmtI(result.stdErrors[index + 1])}\t${fmtI(result.tStats[index + 1])}\t${fmtI(result.pValues[index + 1])}`
    ),
    '',
    'Resumen del modelo',
    `R2: ${result.rSquared.toFixed(6)}`,
    `R2 ajustado: ${result.adjustedRSquared.toFixed(6)}`,
    `RSS: ${residualSumSquares(result).toFixed(6)}`,
    `F-stat: ${isFinite(result.fStat) ? result.fStat.toFixed(6) : 'Infinity'}`,
    `p(F): ${result.fPValue.toFixed(6)}`,
    `Observaciones: ${result.nObs}`,
    `Variables X: ${result.nFeatures}`,
    `Grados de libertad: ${result.df}`,
    `Filas omitidas: ${lastDropped}`,
    '',
    'Conclusion textual',
    interpret(result),
    '',
  ];

  downloadTextFile('quantbay_resultados.txt', lines.join('\n'), 'text/plain');
}

function exportPDF(): void {
  const jspdfLib = (window as any).jspdf;
  if (!jspdfLib?.jsPDF) { showError('Exportación PDF no disponible. Verificá la conexión a internet.'); return; }
  if (!lastResult) { showError('Primero ejecutá una regresión para poder exportar.'); return; }

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
    const noInfPDF = lastResult.restrictedInferenceAvailable === false;
    const pdfI = (v: number, dec = 4): string => noInfPDF ? 'N/D' : (isFinite(v) ? v.toFixed(dec) : '—');
    const pdfCI = (lo: number, hi: number): string => noInfPDF ? 'N/D' : `[${lo.toFixed(4)}, ${hi.toFixed(4)}]`;
    const pdfSig = (p: number): string => noInfPDF ? 'N/D' : significanceLabel(p);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(`Coeficientes y Significancia${noInfPDF ? ' (RLS — inferencia individual N/D)' : ''}`, 10, y);
    y += 4;
    doc.autoTable({
      head: [['Variable', 'Coef.', 'Err. Est.', 't-stat', 'p-valor', 'IC 95%', 'Signif.']],
      body: [
        ['Intercepto', lastResult.intercept.toFixed(6), pdfI(lastResult.stdErrors[0], 6),
          pdfI(lastResult.tStats[0]),
          pdfI(lastResult.pValues[0]),
          pdfCI(lastResult.ci95[0][0], lastResult.ci95[0][1]),
          pdfSig(lastResult.pValues[0])],
        ...lastResult.featureNames.map((n, i) => [n,
          lastResult!.coefficients[i].toFixed(6),
          pdfI(lastResult!.stdErrors[i + 1], 6),
          pdfI(lastResult!.tStats[i + 1]),
          pdfI(lastResult!.pValues[i + 1]),
          pdfCI(lastResult!.ci95[i + 1][0], lastResult!.ci95[i + 1][1]),
          pdfSig(lastResult!.pValues[i + 1])]),
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
    const yName = ($('qb-y') as HTMLSelectElement)?.value ?? '';
    document.querySelectorAll<HTMLInputElement>('.qb-x-cb').forEach(cb => {
      const isY = cb.value === yName;
      cb.disabled = isY;
      if (isY) cb.checked = false;
      const label = cb.closest<HTMLElement>('.qb-x-check');
      if (label) label.style.opacity = isY ? '0.4' : '';
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
