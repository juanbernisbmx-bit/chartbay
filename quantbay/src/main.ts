import { materializeRows, parseCSVFile, parseCSVText, rowCountOf, type ParsedCSV } from './csvParser';
import { type BridgedDataset } from './services/cleanerBridge';
import { loadCsv, type LoadResult } from './services/cleanerLoader';
import { takeHandoff } from './services/datasetHandoff';
import { renderDeviceProfile } from '../../cleaner/js/deviceProfileView';
import { detectDeviceProfile } from '../../cleaner/js/deviceProfiler';

/**
 * Shows what the device is thought to be and what that implied. Only on the
 * WASM path: the PapaParse fallback makes none of these decisions, so a panel
 * describing them would be describing something that did not happen.
 */
function showDeviceProfile(loaded: LoadResult): void {
  const container = $('qb-device-profile');
  if (!container) return;
  if (loaded.engine !== 'wasm') {
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  renderDeviceProfile(container, {
    profile: detectDeviceProfile(),
    budget: loaded.budget,
    preflight: loaded.preflight,
  });
}
import type { RLSConstraint } from './rls';
import { parseRLSRestriction, refineCategoricalRlsError } from './rlsParser';
import { initGuided, renderGuided } from './ui/guidedView';
import { buildAnalysisContext } from './guided/context';
import { recordEstimation, resetForNewDataset } from './guided/session';
import { runRegressionMode, runAutoRegressionMode } from './modes/regressionMode';
import { escapeHtml } from './utils/format';
import { $, setEngineStatus, setMethodStatus, setText, showError, updateSidebarStep, writeRunLog } from './app/dom';
import { appState } from './app/state';
import { exportAnalysisCSV, exportAnalysisTXT, exportPDF } from './ui/exports';
import {
  exportProRegressionCSV,
  exportProRegressionMarkdown,
  exportProRegressionTXT,
  exportProTimeSeriesCSV,
  exportProTimeSeriesMarkdown,
  exportProTimeSeriesTXT,
  proExportState,
} from './pro/proExportView';
import { checkCSVLimits, formatRegressionError } from './ui/errors';
import { renderPreview, renderVarSelectors } from './ui/tables';
import { renderRepairLog } from './ui/diagnosticsView';
import { renderRegressionResults } from './ui/regressionView';
import { recommendFunctionalForm } from './services/formRecommender';
import { renderFormRecommendation, showFormRecommendationPending } from './ui/formRecommendView';
import { detectCategoricalColumns, encodeCategoricalX, encodeForRegression, dummyBaseName, type CategoricalVariableInfo } from './categoricalEncoding';
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
import { getVersionConfig, validateCsvFileSize, type ChartBayVersion } from './versioning/chartbayVersions';
import { renderVersionInfo } from './ui/versionView';
import { resolveEngineAction } from './pro/engineRouting';
import { runPyodideOls, buildEncodedCsvText } from './pro/pyodide/pythonOlsRunner';
import { DEFAULT_PRO_STANDARD_ERROR_TYPE, PRO_STANDARD_ERROR_LABELS, proError } from './pro/pyodide/proResultTypes';
import {
  clearProResult,
  getSelectedProHacMaxLags,
  getSelectedProStandardErrorType,
  hideProPanel,
  renderProResult,
  setProSeSelectorVisible,
  showProPanel,
  showProStatus,
} from './ui/proView';
import { checkProCapability } from './pro/proCapability';
import { checkProFunctionalDomain } from './pro/proDomainCheck';
import { buildLiteComparison } from './pro/liteComparison';
import { runPyodideTimeSeries } from './pro/pyodide/pythonTimeSeriesRunner';
import {
  clearProTimeSeriesResult,
  getProArimaEnabled,
  getProArimaOrder,
  getProForecastSteps,
  getProTimeSeriesAdfRegression,
  getProTimeSeriesMaxLag,
  getSelectedProTimeSeriesDateColumn,
  getSelectedProTimeSeriesValueColumn,
  renderProTimeSeriesNoData,
  renderProTimeSeriesResult,
  renderProTimeSeriesSelectors,
  resetProTimeSeriesView,
  showProTimeSeriesStatus,
} from './ui/proTimeSeriesView';
import type { FunctionalForm } from './functionalForms';
import {
  applyFuturePeriodsToForecast,
  prepareProTimeSeriesValues,
  type PreparedProTimeSeries,
} from './pro/pyodide/proTimeIndex';
import type { PyodideTimeSeriesResult } from './pro/pyodide/proTimeSeriesResultTypes';
import {
  clearAgroContext,
  hideAgroInterpretationPanels,
  initAgroVertical,
  presentAgroInterpretationForPro,
  presentAgroInterpretationForRegression,
} from './verticals/agro';
import { beginModelComparisonDataset, initModelComparisonView } from './ui/modelComparisonView';

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

function categoricalColumnsFor(csvData: ParsedCSV): string[] {
  // The cleaner voted on column types while parsing, so on that path the
  // answer is already known and exact rather than sampled.
  const bridged = csvData as Partial<BridgedDataset>;
  if (bridged.categoricalColumns) return bridged.categoricalColumns;
  return detectCategoricalColumns(csvData.rows, csvData.headers, csvData.numericColumns);
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
 *
 * refineError optionally rewrites rlsParser's generic "not among the selected
 * regressors" message into something more specific before it's shown (used by
 * the Pro path to explain a base-category or renamed-by-dummies reference).
 */
/**
 * Nombres de los coeficientes contra los que se parsea una restricción RLS.
 *
 * NO son las X seleccionadas. Con una X categórica el modelo estima
 * `sector_privado` y `sector_publico`, no `sector`, así que parsear contra la
 * selección cruda armaba una R con una columna de menos por cada dummy extra:
 * la restricción se mostraba en verde y después la estimación moría con
 * "la restricción RLS fila 1 tiene 5 columnas pero el modelo tiene 6
 * parámetros". El camino Pro ya lo hacía bien; Lite y "Arreglar y calcular" no.
 *
 * Usa la codificación de verdad y no una réplica de cómo se nombran las
 * dummies, para que no puedan divergir.
 */
let rlsNamesMemo: {
  data: ParsedCSV;
  key: string;
  names: string[];
  refine: (message: string) => string;
} | null = null;

function rlsCoefficientNames(xNames: string[]): {
  names: string[];
  refine?: (message: string) => string;
} {
  const data = appState.csvData;
  if (!data) return { names: xNames };

  // Sin categóricas entre las X, los nombres finales son los seleccionados.
  // El atajo importa porque el validador corre con cada tecla y codificar
  // reconstruye el dataset entero.
  const categorical = categoricalColumnsFor(data);
  if (!xNames.some(name => categorical.includes(name))) return { names: xNames };

  // Memo por selección: la codificación cambia cuando cambian las X, no cuando
  // cambia el texto de la restricción. La identidad de `data` invalida sola al
  // cargar otro CSV.
  const key = xNames.join('\u0000');
  if (rlsNamesMemo && rlsNamesMemo.data === data && rlsNamesMemo.key === key) return rlsNamesMemo;

  const { encoding } = encodeForRegression(data, xNames);
  rlsNamesMemo = {
    data,
    key,
    names: encoding.expandedXNames,
    refine: (message: string) => refineCategoricalRlsError(message, encoding.categoricalInfo),
  };
  return rlsNamesMemo;
}

function getEffectiveRLSConstraint(
  xNames: string[],
  refineError?: (message: string) => string
): RLSConstraint | undefined | null {
  const typedInput = ($('qb-rls-input') as HTMLInputElement | null)?.value ?? '';
  const trimmed = typedInput.trim();

  if (trimmed) {
    const parsed = parseRLSRestriction(trimmed, xNames);
    if (parsed === '') return undefined; // trimmed is non-empty so this won't happen in practice
    if (typeof parsed === 'string') {
      showRLSValidation(refineError ? refineError(parsed) : parsed, 'error');
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

// Time series + Pro (Pyodide) → diagnósticos de series con statsmodels. Con
// cualquier otra versión (Lite / Mega Pro) sigue el flujo Lite existente, para
// no mezclar corte transversal y series de tiempo de forma silenciosa.
function isProTimeSeries(): boolean {
  return isTimeSeriesMode() && resolveEngineAction(appState.activeVersion) === 'pro_pyodide';
}

// Guards the flows the Pro POC does NOT cover yet (auto-run, time series).
// The standard regression run has its own routing in onRun via resolveEngineAction.
function checkActiveEngineReady(): boolean {
  const config = getVersionConfig(appState.activeVersion);
  if (config.engine === 'typescript') return true;
  showError(
    config.engine === 'pyodide'
      ? 'La acción automática de reparación todavía no está disponible en Pro. Usá "Calcular regresión" en Pro o cambiá a Lite para usar "Arreglar y calcular".'
      : `El motor ${config.label} todavía está en preparación. Para ejecutar este análisis ahora, usá ChartBay Lite.`
  );
  return false;
}

function updateExportButtonState(): void {
  const regressionReady = !!appState.lastResult;
  const timeSeriesReady = !!appState.lastTimeSeriesResult;
  const proRegressionReady = !!(proExportState.lastProResult && proExportState.lastProResult.ok);
  const proTimeSeriesReady = !!(proExportState.lastProTimeSeriesResult && proExportState.lastProTimeSeriesResult.ok);
  for (const id of ['qb-export-pdf', 'qb-export-csv', 'qb-export-txt']) {
    const button = $(id) as HTMLButtonElement | null;
    if (button) button.disabled = !regressionReady;
  }
  for (const id of ['qb-ts-export-pdf', 'qb-ts-export-csv', 'qb-ts-export-txt']) {
    const button = $(id) as HTMLButtonElement | null;
    if (button) button.disabled = !timeSeriesReady;
  }
  for (const id of ['qb-pro-export-md', 'qb-pro-export-txt', 'qb-pro-export-csv']) {
    const button = $(id) as HTMLButtonElement | null;
    if (button) button.disabled = !proRegressionReady;
  }
  for (const id of ['qb-pro-ts-export-md', 'qb-pro-ts-export-txt', 'qb-pro-ts-export-csv']) {
    const button = $(id) as HTMLButtonElement | null;
    if (button) button.disabled = !proTimeSeriesReady;
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
  const proTsPanel = $('qb-pro-ts-panel');
  const ts = isTimeSeriesMode();
  // Pro usa su propio panel de series (statsmodels); Lite y Mega Pro usan el
  // panel Lite existente (Mega Pro sigue bloqueando en el run como antes).
  const proTs = ts && isProTimeSeries();
  const liteTs = ts && !proTs;

  if (demo) demo.style.display = ts ? 'none' : '';
  if (vars) vars.style.display = !ts && appState.csvData && appState.csvData.numericColumns.length >= 2 ? '' : 'none';
  if (results && ts) results.style.display = 'none';
  if (repair && ts) repair.style.display = 'none';
  if (tsPanel) tsPanel.style.display = liteTs ? '' : 'none';
  if (proTsPanel) proTsPanel.style.display = proTs ? '' : 'none';
  if (ts) hideProPanel();

  if (proTs) {
    resetTimeSeriesView();
    if (appState.csvData) renderProTimeSeriesSelectors(appState.csvData);
    else renderProTimeSeriesNoData();
  } else if (liteTs) {
    resetProTimeSeriesView();
    if (appState.csvData) renderTimeSeriesSelectors(appState.csvData);
    else renderTimeSeriesNoData();
  } else {
    resetTimeSeriesView();
    resetProTimeSeriesView();
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

function setActiveVersion(version: ChartBayVersion): void {
  appState.activeVersion = version;
  showError('');
  if (version !== 'pro') hideProPanel();
  renderVersionInfo(getVersionConfig(version));
  setProSeSelectorVisible(resolveEngineAction(version) === 'pro_pyodide');
  // En modo series de tiempo, cambiar de versión intercambia el panel Lite por
  // el panel Pro (statsmodels) y viceversa.
  if (isTimeSeriesMode()) updateModePanels();
}
async function loadDemoCase(id: string): Promise<void> {
  const demo = DEMO_CASES[id];
  if (!demo) return;
  showError('');
  hideProPanel();
  clearAgroContext();
  appState.activeDemoId = id;
  setEngineStatus('LEYENDO');
  writeRunLog([`Cargando demo: ${demo.label}`]);

  try {
    const response = await fetch(`/datasets/${encodeURIComponent(demo.file)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`No se pudo cargar ${demo.file}`);
    const demoCsvText = await response.text();
    appState.csvText = demoCsvText;
    appState.csvData = parseDemoCsv(demoCsvText);
    if (appState.csvData.numericColumns.length < 2) {
      throw new Error('El CSV de ejemplo necesita al menos 2 columnas numéricas.');
    }
    beginModelComparisonDataset(demo.file);

    const fn = $('qb-filename');
    if (fn) fn.textContent = demo.file;
    setText('qb-status-dataset', demo.file);
    setText('qb-status-obs', rowCountOf(appState.csvData));
    setText('qb-status-vars', appState.csvData.numericColumns.length);
    setEngineStatus('LISTO');
    writeRunLog([
      `Demo cargado: ${demo.label}`,
      `Archivo: ${demo.file}`,
      `Restricción sugerida: ${demo.restriction}`,
    ]);

    renderPreview(appState.csvData);
    {
      const categoricalCols = categoricalColumnsFor(appState.csvData);
      renderVarSelectors([...appState.csvData.numericColumns, ...categoricalCols], categoricalCols);
    }
    setVariableSelection(demo.yName, demo.xNames);
    renderDemoInfo(demo);
    runFormRecommendation();

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
/**
 * El CSV como texto, para el único motor que lo necesita.
 *
 * Pro corre statsmodels en Pyodide y le pasa el archivo entero a Python, así
 * que ahí el string es inevitable. Leerlo recién en este punto, y no al subir,
 * es lo que permite que el camino Lite procese archivos que como texto no
 * entrarían en memoria.
 */
async function proCsvText(): Promise<string> {
  if (appState.csvText !== null) return appState.csvText;
  if (!appState.csvFile) throw new Error('No hay archivo original disponible.');
  appState.csvText = await appState.csvFile.text();
  return appState.csvText;
}

// ── Upload ────────────────────────────────────────────────────────────────────

/**
 * Levanta el CSV que dejó la sección Limpiador, si hay uno.
 *
 * Pasa por exactamente el mismo camino que un archivo recién subido —
 * loadFile — en vez de tener una segunda ruta de carga que después haya que
 * mantener en paralelo. Limpiar algo ya limpio es rápido e idempotente.
 */
async function consumeHandoff(): Promise<void> {
  const file = await takeHandoff();
  if (!file) return;
  await loadFile(file);
  writeRunLog(['Dataset recibido desde el Limpiador.']);
}

async function onFileChange(e: Event): Promise<void> {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await loadFile(file);
}

async function loadFile(file: File): Promise<void> {

  const sizeCheck = validateCsvFileSize(file.size, getVersionConfig(appState.activeVersion));
  if (!sizeCheck.ok) {
    showError(sizeCheck.message);
    return;
  }

  showError('');
  hideProPanel();
  clearAgroContext();
  appState.activeDemoId = null;
  appState.lastTimeSeriesResult = null;
  proExportState.lastProResult = null;
  proExportState.lastProTimeSeriesResult = null;
  updateExportButtonState();
  clearDemoInfo();
  const fn = $('qb-filename');
  if (fn) fn.textContent = file.name;
  setText('qb-status-dataset', file.name);
  setEngineStatus('LEYENDO');
  writeRunLog(['Leyendo archivo CSV...']);

  try {
    // No se lee el texto acá. Un CSV de 500 MB serían ~1 GB de string UTF-16
    // en el heap antes de que el limpiador leyera el primer byte, y en el
    // camino Lite nadie lo usa. Pro lo pide bajo demanda en proCsvText().
    appState.csvText = null;
    appState.csvFile = file;
    const loaded = await loadCsv(file, {
      onProgress: fraction => setText('qb-status-obs', `${Math.round(fraction * 100)} %`),
    });
    appState.csvData = loaded.data;
    appState.loadNotes = loaded.notes;
    appState.loadEngine = loaded.engine;
    showDeviceProfile(loaded);
    if (!isTimeSeriesMode() && appState.csvData.numericColumns.length < 2) {
      showError('El CSV necesita al menos 2 columnas numéricas.');
      return;
    }
    beginModelComparisonDataset(file.name);
    setText('qb-status-obs', rowCountOf(appState.csvData));
    setText('qb-status-vars', appState.csvData.numericColumns.length);
    setEngineStatus('LISTO');
    writeRunLog([
      `Dataset cargado: ${rowCountOf(appState.csvData)} observaciones`,
      `Variables numéricas detectadas: ${appState.csvData.numericColumns.length}`,
      isTimeSeriesMode() ? 'Motor de Time Series listo.' : 'Motor de regresión listo.',
      ...(appState.loadNotes ?? []),
    ]);
    renderPreview(appState.csvData);
    {
      const categoricalCols = categoricalColumnsFor(appState.csvData);
      renderVarSelectors([...appState.csvData.numericColumns, ...categoricalCols], categoricalCols);
    }
    updateModePanels();
    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = isTimeSeriesMode() ? 'none' : '';
    if (results) results.style.display = 'none';
    updateSidebarStep(2);
    // Un dataset nuevo invalida el recorrido entero; el historial se conserva.
    resetForNewDataset(file.name);
    renderGuided();
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
  const engineAction = resolveEngineAction(appState.activeVersion);
  if (engineAction === 'blocked') {
    const config = getVersionConfig(appState.activeVersion);
    showError(`El motor ${config.label} todavía está en preparación. Para ejecutar este análisis ahora, usá ChartBay Lite.`);
    return;
  }
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

  if (engineAction === 'pro_pyodide') {
    // Same encoding Lite uses internally (regressionMode.ts) — computed here
    // so both the RLS restriction and the capability check operate on the
    // FINAL post-dummy coefficient names, not the raw pre-encoding selection.
    // Dummy encoding is still row-wise, so this is one of the two places that
    // pays to rebuild rows. materializeRows says so in its name.
    const encoding = encodeCategoricalX(materializeRows(appState.csvData), xNames);
    const invalidCategoricalNames = xNames.filter(
      name =>
        categoricalColumnsFor(appState.csvData!).includes(name) &&
        !encoding.categoricalInfo.some(c => c.originalName === name)
    );

    const rlsConstraint = getEffectiveRLSConstraint(encoding.expandedXNames, msg =>
      refineCategoricalRlsError(msg, encoding.categoricalInfo)
    );
    if (rlsConstraint === null) {
      showError('Corregí la restricción RLS antes de calcular.');
      return;
    }
    const capabilityBlock = checkProCapability({
      rlsConstraint,
      invalidCategoricalNames,
      parameterCount: encoding.expandedXNames.length + 1,
    });
    if (capabilityBlock) {
      hideProPanel();
      showError(capabilityBlock.message);
      return;
    }
    await onRunPro(yName, xNames, appState.activeFunctionalForm, rlsConstraint);
    return;
  }

  const liteRls = rlsCoefficientNames(xNames);
  const rlsConstraint = getEffectiveRLSConstraint(liteRls.names, liteRls.refine);
  if (rlsConstraint === null) {
    showError('Corregí la restricción RLS antes de calcular.');
    return;
  }

  try {
    await technicalLoadSequence();
    const output = runRegressionMode(
      appState.csvData, yName, xNames, rlsConstraint, appState.activeFunctionalForm,
      { dropIncompleteRows: dropIncompleteRowsSelected() }
    );

    appState.lastResult = output.result;
    appState.lastCorr = output.corrMatrix;
    appState.lastCorrCols = output.corrColumns;
    appState.lastVIF = output.vifValues;
    appState.lastLogit = output.logitResult;
    appState.lastCategoricalInfo = output.categoricalInfo;
    appState.lastCategoricalWarnings = output.categoricalWarnings;
    appState.lastHeteroskedasticity = output.heteroskedasticity;

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
        categoricalInfo: output.categoricalInfo,
        categoricalWarnings: output.categoricalWarnings,
        heteroskedasticity: output.heteroskedasticity,
      }
    );
    setText('qb-status-obs', output.result.nObs);
    setEngineStatus('COMPLETADO');
    writeRunLog(output.logEntries);
    presentAgroInterpretationForRegression(yName, output.result, output.functionalForm);
    const res = $('qb-results');
    if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
    updateSidebarStep(3);
    updateExportButtonState();
    // La firma es lo que después delata que la especificación cambió y que lo
    // que está en pantalla quedó viejo (regla G02).
    const signature = buildAnalysisContext().spec?.signature;
    if (signature) recordEstimation(signature);
    renderGuided();
  } catch (err) {
    setEngineStatus('ERROR');
    hideAgroInterpretationPanels();
    showError(formatRegressionError(err));
  }
}

// ── ChartBay Pro (Pyodide) ───────────────────────────────────────────────────

// Pyodide runs Python in a single shared interpreter: two concurrent runs would
// both write to the same global variable names (chartbay_csv_text, etc.) and
// could race. Guard against double-clicking "Calcular" while a run is in flight.
let proRunInFlight = false;

async function onRunPro(
  yName: string,
  xNames: string[],
  form: FunctionalForm,
  rlsConstraint: RLSConstraint | undefined
): Promise<void> {
  if (proRunInFlight) return;
  if ((!appState.csvText && !appState.csvFile) || !appState.csvData) {
    showError('No hay CSV original disponible para el motor Pro. Volvé a cargar el archivo.');
    return;
  }

  proRunInFlight = true;
  const runButton = $('qb-run') as HTMLButtonElement | null;
  if (runButton) runButton.disabled = true;
  proExportState.lastProResult = null;
  updateExportButtonState();

  try {
    showProPanel();
    clearProResult();
    setEngineStatus('CALCULANDO');

    // Same encoding Lite uses internally (regressionMode.ts) — recomputed
    // here rather than threaded from onRun so this function stays
    // self-contained; encodeCategoricalX is pure/deterministic, so this
    // reproduces exactly what the pre-flight capability check already
    // validated.
    const encoding = encodeCategoricalX(materializeRows(appState.csvData), xNames);
    const dummyNames = encoding.categoricalInfo.flatMap(c => c.createdDummies);
    const hasCategorical = encoding.categoricalInfo.length > 0;
    // Only re-serialize to CSV when dummies actually exist — the common
    // numeric-only case keeps sending the original upload's csvText
    // untouched (byte-for-byte, same as before this feature existed).
    const effectiveCsvText = hasCategorical
      ? buildEncodedCsvText(encoding.rows, [yName, ...encoding.expandedXNames])
      : await proCsvText();
    // `columns` MUST be dropped here. Encoding produced new dummy columns that
    // live only in `encoding.rows`; leaving the old columnar store in place
    // would make getValidRowsFrom read the pre-encoding data and silently
    // ignore every dummy.
    const effectiveCsvData: ParsedCSV = {
      ...appState.csvData,
      rows: encoding.rows,
      rowCount: encoding.rows.length,
      columns: undefined,
    };

    // Fail fast on an invalid log domain (Y/X <= 0) before paying the cost of
    // loading Pyodide/numpy/pandas/statsmodels. The Python script re-validates
    // the same domain on its own parsed data as a second line of defense.
    // Dummy columns are excluded (they're always 0/1, never log-transformed).
    const domainError = checkProFunctionalDomain(
      effectiveCsvData,
      yName,
      encoding.expandedXNames,
      form,
      new Set(dummyNames)
    );
    if (domainError) {
      renderProResult(proError(domainError));
      hideAgroInterpretationPanels();
      setEngineStatus('ERROR');
      writeRunLog([`ChartBay Pro: error de dominio — ${domainError}`]);
      return;
    }

    showProStatus('Cargando Python en navegador…');
    writeRunLog(['ChartBay Pro: preparando Python en el navegador…']);

    const rawResult = await runPyodideOls(
      {
        csvText: effectiveCsvText,
        yName,
        xNames: encoding.expandedXNames,
        dummyNames,
        form,
        rlsConstraint,
        standardErrorType: getSelectedProStandardErrorType(),
        hacMaxLags: getSelectedProHacMaxLags(),
        dropIncompleteRows: dropIncompleteRowsSelected(),
      },
      phase => {
        if (phase === 'loading-pyodide') showProStatus('Cargando Python en navegador…');
        else if (phase === 'loading-packages') showProStatus('Cargando numpy, pandas y statsmodels…');
        else showProStatus('Ejecutando OLS con statsmodels…');
      }
    );
    // Categorical metadata (base category, dummies created) is a TS-side
    // concern end to end — attached here for display, never round-tripped
    // through Python's JSON payload (see proResultTypes.ts).
    const result = rawResult.ok ? { ...rawResult, categoricalInfo: encoding.categoricalInfo } : rawResult;

    const comparison = result.ok
      ? buildLiteComparison(appState.csvData, yName, xNames, form, result, rlsConstraint)
      : null;
    renderProResult(result, comparison);
    presentAgroInterpretationForPro(yName, result);
    // Sólo se guarda para exportar cuando la corrida fue exitosa; un error deja
    // el estado en null y los botones de exportación deshabilitados.
    proExportState.lastProResult = result.ok ? result : null;
    updateExportButtonState();
    setEngineStatus(result.ok ? 'COMPLETADO' : 'ERROR');
    writeRunLog(
      result.ok
        ? [
            'ChartBay Pro: OLS ejecutado con statsmodels (Pyodide)... OK',
            `Observaciones: ${result.nobs}`,
            `Inferencia: ${PRO_STANDARD_ERROR_LABELS[result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE]}`,
            ...result.warnings,
          ]
        : [`ChartBay Pro: error — ${result.error ?? 'desconocido'}`]
    );
    const panel = $('qb-pro-results');
    if (panel) panel.scrollIntoView({ behavior: 'smooth' });
    updateSidebarStep(3);
    // Igual que en el camino Lite: sin registrar la firma, la guía seguiría
    // creyendo que lo que está en pantalla corresponde a la estimación
    // anterior y avisaría de un desactualizado que no existe.
    if (result.ok) {
      const proSignature = buildAnalysisContext().spec?.signature;
      if (proSignature) recordEstimation(proSignature);
    }
    renderGuided();
  } finally {
    proRunInFlight = false;
    if (runButton) runButton.disabled = false;
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

function onAutoRun(): void {
  if (isTimeSeriesMode()) return;
  if (!appState.csvData) return;
  if (!checkActiveEngineReady()) return;
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

  const autoRls = rlsCoefficientNames(xNames);
  const rlsConstraint = getEffectiveRLSConstraint(autoRls.names, autoRls.refine);
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
    appState.lastCategoricalInfo = output.categoricalInfo;
    appState.lastCategoricalWarnings = output.categoricalWarnings;
    appState.lastHeteroskedasticity = output.heteroskedasticity;

    setMethodStatus(output.method);
    renderRepairLog(output.repairResult, output.rlsFallbackNote);
    renderRegressionResults(
      output.result,
      output.dropped,
      output.corrMatrix,
      output.corrColumns,
      output.vifValues,
      {
        functionalForm: output.functionalForm,
        categoricalInfo: output.categoricalInfo,
        categoricalWarnings: output.categoricalWarnings,
        heteroskedasticity: output.heteroskedasticity,
      }
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
  if (!checkActiveEngineReady()) return;
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
  const result = runTimeSeriesAnalysis(materializeRows(appState.csvData, { dates: 'iso' }), {
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

// ── ChartBay Pro · Time Series (Pyodide) ─────────────────────────────────────
// Como el OLS Pro, Pyodide corre en un único intérprete Python compartido: dos
// corridas simultáneas escribirían las mismas globales (chartbay_ts_*) y podrían
// pisarse. Guarda contra doble click en "Correr diagnósticos" mientras hay una
// corrida en vuelo.
let proTsRunInFlight = false;

function withPreparedProTimeIndex(
  result: PyodideTimeSeriesResult,
  prepared: PreparedProTimeSeries
): PyodideTimeSeriesResult {
  if (!result.ok) return result;
  const preparedWarnings = prepared.timeIndex
    ? prepared.warnings.filter(warning => !prepared.timeIndex?.warnings.includes(warning))
    : prepared.warnings;
  const warnings = preparedWarnings.length > 0
    ? [...preparedWarnings, ...result.warnings]
    : result.warnings;
  if (!prepared.timeIndex) return { ...result, warnings };
  const arima = result.arima?.forecast
    ? {
        ...result.arima,
        forecast: applyFuturePeriodsToForecast(result.arima.forecast, prepared.timeIndex),
      }
    : result.arima;
  return {
    ...result,
    arima,
    timeIndex: prepared.timeIndex,
    warnings,
  };
}

async function onRunProTimeSeries(): Promise<void> {
  if (proTsRunInFlight) return;
  if (!appState.csvData) {
    renderProTimeSeriesNoData();
    return;
  }
  const valueColumn = getSelectedProTimeSeriesValueColumn();
  if (!valueColumn) {
    renderProTimeSeriesNoData('Seleccioná una columna de serie para diagnosticar.');
    return;
  }

  proTsRunInFlight = true;
  const runButton = $('qb-pro-ts-run') as HTMLButtonElement | null;
  if (runButton) runButton.disabled = true;
  appState.lastTimeSeriesResult = null;
  proExportState.lastProTimeSeriesResult = null;
  updateExportButtonState();

  try {
    showError('');
    clearProTimeSeriesResult();
    setEngineStatus('CALCULANDO');

    const prepared = prepareProTimeSeriesValues(
      appState.csvData,
      valueColumn,
      getSelectedProTimeSeriesDateColumn()
    );
    if (!prepared.ok) {
      const errorResult: PyodideTimeSeriesResult = {
        ok: false,
        engine: 'pyodide',
        warnings: [],
        error: prepared.error,
      };
      renderProTimeSeriesResult(errorResult);
      setEngineStatus('ERROR');
      writeRunLog([`ChartBay Pro: error — ${prepared.error}`]);
      return;
    }
    const { values } = prepared.value;

    showProTimeSeriesStatus('Cargando Python en navegador…');
    writeRunLog(['ChartBay Pro: preparando diagnósticos de series de tiempo…']);

    const runArima = getProArimaEnabled();
    const rawResult = await runPyodideTimeSeries(
      {
        values,
        variableName: valueColumn,
        maxLag: getProTimeSeriesMaxLag(),
        adfRegression: getProTimeSeriesAdfRegression(),
        runArima,
        arimaOrder: runArima ? getProArimaOrder() : undefined,
        // El horizonte sólo se envía con ARIMA activo: sin modelo estimado no
        // hay forecast posible (el runner también lo ignora sin runArima).
        forecastSteps: runArima ? getProForecastSteps() : undefined,
      },
      phase => {
        if (phase === 'loading-pyodide') showProTimeSeriesStatus('Cargando Python en navegador…');
        else if (phase === 'loading-packages') showProTimeSeriesStatus('Cargando numpy, pandas y statsmodels…');
        else showProTimeSeriesStatus('Ejecutando diagnósticos con statsmodels…');
      }
    );
    const result = withPreparedProTimeIndex(rawResult, prepared.value);

    // El gráfico de forecast dibuja los últimos observados: se pasan las
    // observaciones finitas de la serie (mismas que valida el runner).
    renderProTimeSeriesResult(result, prepared.value.observedValues);
    proExportState.lastProTimeSeriesResult = result.ok ? result : null;
    updateExportButtonState();
    setEngineStatus(result.ok ? 'COMPLETADO' : 'ERROR');
    if (result.ok) setText('qb-status-obs', result.observations ?? 0);
    writeRunLog(
      result.ok
        ? [
            'ChartBay Pro: diagnósticos de series ejecutados con statsmodels (Pyodide)... OK',
            `Serie: ${valueColumn}`,
            ...(result.timeIndex ? [`Índice temporal: ${result.timeIndex.columnName} (${result.timeIndex.frequency})`] : []),
            `Observaciones: ${result.observations}`,
            ...(result.arima
              ? [`ARIMA(${result.arima.order.p},${result.arima.order.d},${result.arima.order.q}) estimado (AIC: ${result.arima.aic ?? '—'})`]
              : []),
            ...(result.arimaError ? [`ARIMA: ${result.arimaError}`] : []),
            ...(result.arima?.forecast ? [`Forecast: ${result.arima.forecast.steps} períodos generados`] : []),
            ...(result.arima?.forecastError ? [`Forecast: ${result.arima.forecastError}`] : []),
            ...result.warnings,
          ]
        : [`ChartBay Pro: error — ${result.error ?? 'desconocido'}`]
    );
    const panel = $('qb-pro-ts-panel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth' });
    updateSidebarStep(3);
  } finally {
    proTsRunInFlight = false;
    if (runButton) runButton.disabled = false;
  }
}

function onProTimeSeriesValueChange(): void {
  // Al cambiar la columna de serie se descartan los diagnósticos previos para
  // no dejar tablas viejas de otra variable visibles.
  appState.lastTimeSeriesResult = null;
  proExportState.lastProTimeSeriesResult = null;
  updateExportButtonState();
  clearProTimeSeriesResult();
}

function onTimeSeriesTransformationChange(): void {
  syncTimeSeriesTransformationControls();
  if (isTimeSeriesMode() && appState.csvData) {
    onTimeSeriesRun();
  }
}

// ── ChartBay Agro bridge ──────────────────────────────────────────────────
// Única puerta de entrada para que el vertical Agro cargue un dataset (CSV en
// memoria) en el flujo existente de Econometría, reutilizando la misma
// orquestación que onFileChange usa para un archivo subido a mano. Nunca
// corre el modelo: sólo deja el CSV cargado y, si es seguro, las variables
// preseleccionadas para que el usuario revise antes de calcular.
function initialQuantbayModule(): 'econometria' | 'agro' {
  const module = document.querySelector<HTMLElement>('[data-qb-module]')?.dataset.qbModule;
  return module === 'agro' ? 'agro' : 'econometria';
}

function setElementsDisplay(selector: string, display: string): void {
  document.querySelectorAll<HTMLElement>(selector).forEach(el => {
    el.style.display = display;
  });
}

function applyInitialModuleLayout(): void {
  if (initialQuantbayModule() !== 'agro') return;
  setElementsDisplay('.qb-econometria-chrome', 'none');
  setElementsDisplay('.qb-econometria-section', 'none');
}

function revealEconometriaWorkspaceForAgro(): void {
  if (initialQuantbayModule() !== 'agro') return;
  document.querySelector<HTMLElement>('[data-qb-module]')?.classList.remove('qb-agro-initial');
  setElementsDisplay('.qb-econometria-chrome', '');
}

function agroLoadDataset(params: {
  csvText: string;
  label: string;
  suggestedY?: string;
  suggestedX?: string[];
}): { ok: boolean; numericColumns: string[]; message?: string } {
  showError('');
  hideProPanel();
  appState.activeDemoId = null;
  appState.lastTimeSeriesResult = null;
  proExportState.lastProResult = null;
  proExportState.lastProTimeSeriesResult = null;
  updateExportButtonState();
  clearDemoInfo();
  if (isTimeSeriesMode()) setActiveMode('regression');

  const fn = $('qb-filename');
  if (fn) fn.textContent = params.label;
  setText('qb-status-dataset', params.label);
  setEngineStatus('LEYENDO');
  writeRunLog([`ChartBay Agro: cargando "${params.label}"...`]);

  try {
    appState.csvText = params.csvText;
    appState.csvData = parseCSVText(params.csvText);
    if (appState.csvData.numericColumns.length < 2) {
      throw new Error('El dataset necesita al menos 2 columnas numéricas.');
    }
    beginModelComparisonDataset(params.label);
    setText('qb-status-obs', rowCountOf(appState.csvData));
    setText('qb-status-vars', appState.csvData.numericColumns.length);
    setEngineStatus('LISTO');
    writeRunLog([
      `Dataset cargado: ${rowCountOf(appState.csvData)} observaciones`,
      `Variables numéricas detectadas: ${appState.csvData.numericColumns.length}`,
      'Motor de regresión listo.',
    ]);

    renderPreview(appState.csvData);
    const categoricalCols = categoricalColumnsFor(appState.csvData);
    renderVarSelectors([...appState.csvData.numericColumns, ...categoricalCols], categoricalCols);
    revealEconometriaWorkspaceForAgro();
    updateModePanels();

    const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results'), repair = $('qb-repair-log');
    if (preview) preview.style.display = '';
    if (vars) vars.style.display = '';
    if (results) results.style.display = 'none';
    if (repair) repair.style.display = 'none';

    if (params.suggestedY && appState.csvData.numericColumns.includes(params.suggestedY)) {
      const selectable = new Set([...appState.csvData.numericColumns, ...categoricalCols]);
      const safeX = (params.suggestedX ?? []).filter(x => selectable.has(x) && x !== params.suggestedY);
      setVariableSelection(params.suggestedY, safeX);
    }
    runFormRecommendation();
    updateSidebarStep(2);

    return { ok: true, numericColumns: appState.csvData.numericColumns };
  } catch (err) {
    setEngineStatus('ERROR');
    const message = (err as Error).message;
    showError(`Error al cargar dataset de Agro: ${message}`);
    return { ok: false, numericColumns: [], message };
  }
}

/**
 * Lee el checkbox de listwise. Vale para los dos motores: Lite se niega a
 * estimar con huecos y Pro los descartaba siempre, así que sin un único control
 * el mismo CSV daba error en uno y resultado en el otro.
 */
/** El campo de rezagos sólo aplica a HAC; con el resto no significa nada. */
function syncProHacVisibility(): void {
  const wrap = $('qb-pro-hac-wrap');
  if (!wrap) return;
  wrap.style.display = getSelectedProStandardErrorType() === 'HAC' ? '' : 'none';
}

function dropIncompleteRowsSelected(): boolean {
  return ($('qb-drop-incomplete') as HTMLInputElement | null)?.checked ?? false;
}

/**
 * Agrupa los recálculos de la recomendación.
 *
 * Estima cuatro OLS sobre el dataset entero — medido: ~1 s con 200 000 filas,
 * en el hilo principal — y se dispara con cada click en una casilla X. Sin
 * agrupar, tildar tres variables congela la página tres veces seguidas. El
 * panel pasa a "recalculando" en el acto para no dejar a la vista los números
 * de la selección anterior.
 */
let formRecommendationTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleFormRecommendation(): void {
  if (formRecommendationTimer !== undefined) clearTimeout(formRecommendationTimer);
  showFormRecommendationPending();
  formRecommendationTimer = setTimeout(() => {
    formRecommendationTimer = undefined;
    runFormRecommendation();
  }, 250);
}

function runFormRecommendation(): void {
  if (!appState.csvData || isTimeSeriesMode()) {
    renderFormRecommendation(null);
    return;
  }
  const yName = ($('qb-y') as HTMLSelectElement | null)?.value ?? '';
  const xNames = Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v !== yName);

  if (!yName || xNames.length === 0) {
    renderFormRecommendation(null);
    return;
  }

  try {
    renderFormRecommendation(recommendFunctionalForm(appState.csvData, yName, xNames));
  } catch {
    renderFormRecommendation(null);
  }
}

function init(): void {
  initGuided(focus => {
    const el = document.getElementById(focus);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    (el as HTMLElement | null)?.focus?.();
  });
  renderGuided();
  // Listeners propios y aditivos: el plan se recalcula ante cualquier cambio
  // que altere la especificación. El planificador es puro y barato, así que
  // redibujar de más no cuesta nada.
  for (const id of ['qb-y', 'qb-x-checks', 'qb-form', 'qb-mode', 'qb-drop-incomplete', 'qb-pro-se']) {
    $(id)?.addEventListener('change', () => renderGuided());
  }
  $('qb-rls-input')?.addEventListener('input', () => renderGuided());
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
  $('qb-version')?.addEventListener('change', event => {
    const value = (event.target as HTMLSelectElement).value;
    const version: ChartBayVersion = value === 'pro' ? 'pro' : 'lite';
    setActiveVersion(version);
  });
  $('qb-ts-date')?.addEventListener('change', onTimeSeriesDateChange);
  $('qb-ts-run')?.addEventListener('click', onTimeSeriesRun);
  $('qb-ts-transform')?.addEventListener('change', onTimeSeriesTransformationChange);
  $('qb-ts-ma-window')?.addEventListener('change', onTimeSeriesTransformationChange);
  $('qb-pro-ts-run')?.addEventListener('click', onRunProTimeSeries);
  $('qb-pro-ts-value')?.addEventListener('change', onProTimeSeriesValueChange);
  $('qb-pro-ts-date')?.addEventListener('change', onProTimeSeriesValueChange);
  $('qb-export-pdf')?.addEventListener('click', exportPDF);
  $('qb-export-csv')?.addEventListener('click', exportAnalysisCSV);
  $('qb-export-txt')?.addEventListener('click', exportAnalysisTXT);
  $('qb-ts-export-pdf')?.addEventListener('click', exportPDF);
  $('qb-ts-export-csv')?.addEventListener('click', exportAnalysisCSV);
  $('qb-ts-export-txt')?.addEventListener('click', exportAnalysisTXT);
  $('qb-pro-export-md')?.addEventListener('click', exportProRegressionMarkdown);
  $('qb-pro-export-txt')?.addEventListener('click', exportProRegressionTXT);
  $('qb-pro-export-csv')?.addEventListener('click', exportProRegressionCSV);
  $('qb-pro-ts-export-md')?.addEventListener('click', exportProTimeSeriesMarkdown);
  $('qb-pro-ts-export-txt')?.addEventListener('click', exportProTimeSeriesTXT);
  $('qb-pro-ts-export-csv')?.addEventListener('click', exportProTimeSeriesCSV);

  $('qb-pro-se')?.addEventListener('change', syncProHacVisibility);
  syncProHacVisibility();

  $('qb-y')?.addEventListener('change', () => {
    applyYIndicators(($('qb-y') as HTMLSelectElement)?.value ?? '');
    scheduleFormRecommendation();
  });

  $('qb-x-checks')?.addEventListener('change', scheduleFormRecommendation);

  $('qb-form-apply')?.addEventListener('click', () => {
    const form = ($('qb-form-apply') as HTMLButtonElement | null)?.dataset.form ?? '';
    if (form === 'lin-lin' || form === 'log-lin' || form === 'lin-log' || form === 'log-log') {
      const sel = $('qb-form') as HTMLSelectElement | null;
      if (sel) {
        sel.value = form;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
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

    const { names, refine } = rlsCoefficientNames(xNames);
    const result = parseRLSRestriction(input.trim(), names);
    if (result === '') {
      showRLSValidation('', '');
    } else if (typeof result === 'string') {
      showRLSValidation(refine ? refine(result) : result, 'error');
    } else {
      showRLSValidation(`✓ Restricción: ${result.label}`, 'ok');
    }
  });

  renderVersionInfo(getVersionConfig(appState.activeVersion));
  setProSeSelectorVisible(resolveEngineAction(appState.activeVersion) === 'pro_pyodide');
  updateModePanels();
  updateExportButtonState();
  initModelComparisonView();
  applyInitialModuleLayout();
  // Vertical Agro: no-op si el flag está apagado o el panel no existe.
  initAgroVertical({ loadDataset: agroLoadDataset });
  // Si el usuario llegó desde el Limpiador, el dataset ya está esperando.
  void consumeHandoff();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
