import { parseCSVFile, type ParsedCSV } from './csvParser';
import type { RLSConstraint } from './rls';
import { parseRLSRestriction } from './rlsParser';
import { runRegressionMode, runAutoRegressionMode } from './modes/regressionMode';
import { escapeHtml } from './utils/format';
import { $, setEngineStatus, setMethodStatus, setText, showError, updateSidebarStep, writeRunLog } from './app/dom';
import { appState } from './app/state';
import { exportAnalysisCSV, exportAnalysisTXT, exportPDF } from './ui/exports';
import { checkCSVLimits, formatRegressionError } from './ui/errors';
import { renderPreview, renderVarSelectors } from './ui/tables';
import { renderRepairLog } from './ui/diagnosticsView';
import { renderRegressionResults } from './ui/regressionView';
import { runTimeSeriesAnalysis } from './timeseries/service';
import {
  getACFMaxLag,
  getMovingAverageWindow,
  getSelectedTimeSeriesTransformation,
  renderTimeSeriesAnalysis,
  renderTimeSeriesNoData,
  renderTimeSeriesSelectors,
  resetTimeSeriesView,
  syncTimeSeriesTransformationControls,
} from './ui/timeseriesView';

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

function showRLSValidation(msg: string, type: 'ok' | 'error' | ''): void {
  const el = $('qb-rls-validation');
  if (!el) return;
  el.textContent = msg;
  el.style.color = type === 'error' ? '#e55' : type === 'ok' ? '#4de3b5' : '';
  if (msg) {
    const details = document.getElementById('qb-rls-details') as HTMLDetailsElement | null;
    if (details) details.open = true;
  }
}

/**
 * Returns the RLS constraint to use for the next run:
 *   - The user's typed restriction (takes priority), if non-empty and valid.
 *   - The active demo's constraint, if no typed restriction.
 *   - undefined  → no constraint → plain OLS.
 *   - null       → typed input was non-empty but invalid; validation error already shown.
 */
function getEffectiveRLSConstraint(xNames: string[]): RLSConstraint | undefined | null {
  const typedInput = ($('qb-rls-input') as HTMLInputElement | null)?.value ?? '';
  const trimmed = typedInput.trim();

  if (trimmed) {
    const parsed = parseRLSRestriction(trimmed, xNames);
    if (parsed === '') return undefined; // trimmed is non-empty so this won't happen in practice
    if (typeof parsed === 'string') {
      showRLSValidation(parsed, 'error');
      return null;
    }
    const demoHasConstraint = !!(appState.activeDemoId && DEMO_CASES[appState.activeDemoId]?.rlsConstraint);
    const note = demoHasConstraint
      ? '✓ Restricción manual activa — se ignora la del demo.'
      : `✓ Restricción: ${parsed.label}`;
    showRLSValidation(note, 'ok');
    return parsed;
  }

  showRLSValidation('', '');
  return appState.activeDemoId ? DEMO_CASES[appState.activeDemoId]?.rlsConstraint : undefined;
}

function isTimeSeriesMode(): boolean {
  return appState.activeMode === 'timeseries';
}

function updateExportButtonState(): void {
  const regressionReady = !!appState.lastResult;
  const timeSeriesReady = !!appState.lastTimeSeriesResult;
  for (const id of ['qb-export-pdf', 'qb-export-csv', 'qb-export-txt']) {
    const button = $(id) as HTMLButtonElement | null;
    if (button) button.disabled = !regressionReady;
  }
  for (const id of ['qb-ts-export-pdf', 'qb-ts-export-csv', 'qb-ts-export-txt']) {
    const button = $(id) as HTMLButtonElement | null;
    if (button) button.disabled = !timeSeriesReady;
  }
}

function updateModePanels(): void {
  const modeSelect = $('qb-mode') as HTMLSelectElement | null;
  if (modeSelect) modeSelect.value = appState.activeMode;

  const demo = $('qb-demo-panel');
  const vars = $('qb-vars');
  const results = $('qb-results');
  const repair = $('qb-repair-log');
  const tsPanel = $('qb-ts-panel');
  const ts = isTimeSeriesMode();

  if (demo) demo.style.display = ts ? 'none' : '';
  if (vars) vars.style.display = !ts && appState.csvData && appState.csvData.numericColumns.length >= 2 ? '' : 'none';
  if (results && ts) results.style.display = 'none';
  if (repair && ts) repair.style.display = 'none';
  if (tsPanel) tsPanel.style.display = ts ? '' : 'none';

  if (ts) {
    if (appState.csvData) renderTimeSeriesSelectors(appState.csvData);
    else renderTimeSeriesNoData();
  } else {
    resetTimeSeriesView();
    if (appState.csvData && appState.csvData.numericColumns.length < 2) {
      showError('El CSV necesita al menos 2 columnas numéricas.');
    }
  }
}

function setActiveMode(mode: 'regression' | 'timeseries'): void {
  appState.activeMode = mode;
  showError('');
  updateModePanels();
  updateExportButtonState();
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
    if (vars) vars.style.display = isTimeSeriesMode() ? 'none' : '';
    if (results) results.style.display = 'none';
    if (repair) repair.style.display = 'none';

    await onRun();
  } catch (err) {
    setEngineStatus('ERROR');
    showError(`Error al cargar demo: ${(err as Error).message}`);
  }
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
  appState.lastTimeSeriesResult = null;
  updateExportButtonState();
  clearDemoInfo();
  const fn = $('qb-filename');
  if (fn) fn.textContent = file.name;
  setText('qb-status-dataset', file.name);
  setEngineStatus('LEYENDO');
  writeRunLog(['Leyendo archivo CSV...']);

  try {
    appState.csvData = await parseCSVFile(file);
    if (!isTimeSeriesMode() && appState.csvData.numericColumns.length < 2) {
      showError('El CSV necesita al menos 2 columnas numéricas.');
      return;
    }
    setText('qb-status-obs', appState.csvData.rows.length);
    setText('qb-status-vars', appState.csvData.numericColumns.length);
    setEngineStatus('LISTO');
    writeRunLog([
      `Dataset cargado: ${appState.csvData.rows.length} observaciones`,
      `Variables numéricas detectadas: ${appState.csvData.numericColumns.length}`,
      isTimeSeriesMode() ? 'Motor de Time Series listo.' : 'Motor de regresión listo.',
    ]);
    renderPreview(appState.csvData);
    renderVarSelectors(appState.csvData.numericColumns);
    updateModePanels();
    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = isTimeSeriesMode() ? 'none' : '';
    if (results) results.style.display = 'none';
    updateSidebarStep(2);
  } catch (err) {
    setEngineStatus('ERROR');
    showError(`Error al leer el archivo: ${(err as Error).message}`);
  }
}

// ── Preview ───────────────────────────────────────────────────────────────────
// ── Variable selectors ────────────────────────────────────────────────────────
// ── Run regression ────────────────────────────────────────────────────────────

async function onRun(): Promise<void> {
  if (isTimeSeriesMode()) return;
  if (!appState.csvData) return;
  appState.lastTimeSeriesResult = null;
  updateExportButtonState();
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

  const rlsConstraint = getEffectiveRLSConstraint(xNames);
  if (rlsConstraint === null) {
    showError('Corregí la restricción RLS antes de calcular.');
    return;
  }

  try {
    await technicalLoadSequence();
    const output = runRegressionMode(appState.csvData, yName, xNames, rlsConstraint, appState.activeFunctionalForm);

    appState.lastResult = output.result;
    appState.lastCorr = output.corrMatrix;
    appState.lastCorrCols = output.corrColumns;
    appState.lastVIF = output.vifValues;
    appState.lastLogit = output.logitResult;

    setMethodStatus(output.method);
    renderRegressionResults(
      output.result,
      output.dropped,
      output.corrMatrix,
      output.corrColumns,
      output.vifValues,
      {
        binary: output.binary,
        leaks: output.leaks,
        logitResult: output.logitResult,
        functionalForm: output.functionalForm,
      }
    );
    setText('qb-status-obs', output.result.nObs);
    setEngineStatus('COMPLETADO');
    writeRunLog(output.logEntries);
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
    updateSidebarStep(3);
    updateExportButtonState();
  } catch (err) {
    setEngineStatus('ERROR');
    showError(formatRegressionError(err));
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

function onAutoRun(): void {
  if (isTimeSeriesMode()) return;
  if (!appState.csvData) return;
  appState.lastTimeSeriesResult = null;
  updateExportButtonState();
  showError('');

  const yName  = ($('qb-y') as HTMLSelectElement)?.value ?? '';
  const xNames = Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v !== yName);

  if (xNames.length === 0) {
    showError('Seleccioná al menos una variable X distinta de Y.');
    return;
  }

  const rlsConstraint = getEffectiveRLSConstraint(xNames);
  if (rlsConstraint === null) {
    showError('Corregí la restricción RLS antes de calcular.');
    return;
  }

  try {
    const output = runAutoRegressionMode(appState.csvData, yName, xNames, rlsConstraint, appState.activeFunctionalForm);

    appState.lastResult   = output.result;
    appState.lastCorr     = output.corrMatrix;
    appState.lastCorrCols = output.corrColumns;
    appState.lastVIF      = output.vifValues;
    appState.lastLogit    = null;

    setMethodStatus(output.method);
    renderRepairLog(output.repairResult, output.rlsFallbackNote);
    renderRegressionResults(
      output.result,
      output.dropped,
      output.corrMatrix,
      output.corrColumns,
      output.vifValues,
      { functionalForm: output.functionalForm }
    );

    setEngineStatus('COMPLETADO');
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
    updateExportButtonState();
  } catch (err) {
    showError(formatRegressionError(err));
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────


function onTimeSeriesDateChange(): void {
  if (!appState.csvData) return;
  appState.lastTimeSeriesResult = null;
  updateExportButtonState();
  const dateColumn = ($('qb-ts-date') as HTMLSelectElement | null)?.value ?? '';
  const valueColumn = ($('qb-ts-value') as HTMLSelectElement | null)?.value ?? '';
  renderTimeSeriesSelectors(appState.csvData, dateColumn, valueColumn);
}

function onTimeSeriesRun(): void {
  if (!appState.csvData) {
    appState.lastTimeSeriesResult = null;
    updateExportButtonState();
    renderTimeSeriesNoData();
    return;
  }

  const dateColumn = ($('qb-ts-date') as HTMLSelectElement | null)?.value ?? '';
  const valueColumn = ($('qb-ts-value') as HTMLSelectElement | null)?.value ?? '';

  if (!dateColumn || !valueColumn) {
    appState.lastTimeSeriesResult = null;
    updateExportButtonState();
    renderTimeSeriesNoData('Selecciona una columna de fecha y una columna de valor para Time Series.');
    return;
  }

  showError('');
  const result = runTimeSeriesAnalysis(appState.csvData.rows, {
    dateColumn,
    valueColumn,
    transformation: getSelectedTimeSeriesTransformation(),
    movingAverageWindow: getMovingAverageWindow(),
    acfMaxLag: getACFMaxLag(),
  });
  appState.lastTimeSeriesResult = result;
  renderTimeSeriesAnalysis(result);
  setText('qb-status-obs', result.summary.observations);
  setEngineStatus('COMPLETADO');
  writeRunLog([
    `Time Series ejecutado: ${valueColumn}`,
    `Fecha: ${dateColumn}`,
    `Observaciones validas: ${result.summary.observations}`,
  ]);
  const panel = $('qb-ts-panel');
  if (panel) panel.scrollIntoView({ behavior: 'smooth' });
  updateSidebarStep(3);
  updateExportButtonState();
}

function onTimeSeriesTransformationChange(): void {
  syncTimeSeriesTransformationControls();
  if (isTimeSeriesMode() && appState.csvData) {
    onTimeSeriesRun();
  }
}
function init(): void {
  $('qb-file')?.addEventListener('change', onFileChange as EventListener);
  document.querySelectorAll<HTMLButtonElement>('.qb-demo-btn').forEach(btn => {
    btn.addEventListener('click', () => loadDemoCase(btn.dataset.demo ?? ''));
  });
  $('qb-run')?.addEventListener('click', onRun);
  $('qb-auto-run')?.addEventListener('click', onAutoRun);
  $('qb-mode')?.addEventListener('change', event => {
    const mode = (event.target as HTMLSelectElement).value === 'timeseries' ? 'timeseries' : 'regression';
    setActiveMode(mode);
  });
  $('qb-ts-date')?.addEventListener('change', onTimeSeriesDateChange);
  $('qb-ts-run')?.addEventListener('click', onTimeSeriesRun);
  $('qb-ts-transform')?.addEventListener('change', onTimeSeriesTransformationChange);
  $('qb-ts-ma-window')?.addEventListener('change', onTimeSeriesTransformationChange);
  $('qb-export-pdf')?.addEventListener('click', exportPDF);
  $('qb-export-csv')?.addEventListener('click', exportAnalysisCSV);
  $('qb-export-txt')?.addEventListener('click', exportAnalysisTXT);
  $('qb-ts-export-pdf')?.addEventListener('click', exportPDF);
  $('qb-ts-export-csv')?.addEventListener('click', exportAnalysisCSV);
  $('qb-ts-export-txt')?.addEventListener('click', exportAnalysisTXT);

  $('qb-y')?.addEventListener('change', () => {
    applyYIndicators(($('qb-y') as HTMLSelectElement)?.value ?? '');
  });

  $('qb-form')?.addEventListener('change', () => {
    const val = ($('qb-form') as HTMLSelectElement)?.value ?? 'lin-lin';
    if (val === 'lin-lin' || val === 'log-lin' || val === 'lin-log' || val === 'log-log') {
      appState.activeFunctionalForm = val;
    }
  });

  $('qb-rls-input')?.addEventListener('input', () => {
    const input = ($('qb-rls-input') as HTMLInputElement | null)?.value ?? '';
    if (!input.trim()) { showRLSValidation('', ''); return; }

    const yName = ($('qb-y') as HTMLSelectElement | null)?.value ?? '';
    const xNames = Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
      .map(cb => cb.value)
      .filter(v => v !== yName);

    if (xNames.length === 0) {
      showRLSValidation('Primero seleccioná al menos una variable X.', 'error');
      return;
    }

    const result = parseRLSRestriction(input.trim(), xNames);
    if (result === '') {
      showRLSValidation('', '');
    } else if (typeof result === 'string') {
      showRLSValidation(result, 'error');
    } else {
      showRLSValidation(`✓ Restricción: ${result.label}`, 'ok');
    }
  });

  updateModePanels();
  updateExportButtonState();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
