// ChartBay Agro — vista inicial del vertical.
//
// UI mínima y 100% aditiva: si el panel #qb-agro-panel no existe en el HTML o
// el vertical está apagado por flag, initAgroVertical() es un no-op. La UI de
// Econometría no depende de nada de este archivo.
//
// Puente con Econometría: agroView.ts NO importa main.ts (crearía un import
// circular, ya que main.ts importa este módulo). En cambio, main.ts inyecta
// un AgroEconometriaBridge con la única pieza que necesita reutilizar del
// flujo existente (cargar CSV + preseleccionar variables, revisable antes de
// correr); todo lo demás (detección, presets, margen, interpretación) vive acá.

import { $ } from '../../app/dom';
import { downloadTextFile } from '../../ui/exports';
import { escapeHtml } from '../../utils/format';
import type { FunctionalForm } from '../../functionalForms';
import type { RegressionResult } from '../../regression';
import { detectAgroColumns } from './agroColumnDetection';
import { AGRO_CSV_TEMPLATES, agroCsvTemplateToCsv } from './agroCsvTemplates';
import { AGRO_DATA_CATALOG } from './agroDataCatalog';
import {
  AGRO_EXAMPLE_DATASETS,
  agroDatasetToCsv,
  generateLargeAgroSyntheticDataset,
  getAgroExampleById,
} from './agroExamples';
import { isVerticalEnabled } from './agroFeatureFlags';
import {
  fromPyodideOlsResult,
  fromRegressionResult,
  interpretAgroRegressionResult,
  type AgroPyodideResultLike,
} from './agroInterpretation';
import { calculateAgroMargin, formatAgroMarginSummary } from './agroMargin';
import { assessAgroModelCapacity } from './agroModelCapacity';
import { agroRoleLabel, suggestAgroModelPresets } from './agroModelPresets';
import type {
  AgroColumnDetectionResult,
  AgroColumnRole,
  AgroCrop,
  AgroExampleDataset,
  AgroInterpretation,
  AgroInterpretationContext,
  AgroMarginInput,
  AgroMarginResult,
  AgroModelPresetSuggestion,
  AgroYieldUnit,
} from './agroTypes';

const CROPS: AgroCrop[] = ['soja', 'maiz', 'trigo', 'girasol', 'sorgo', 'cebada', 'otro'];
const YIELD_UNITS: Array<{ id: AgroYieldUnit; label: string }> = [
  { id: 'kg_ha', label: 'kg/ha' },
  { id: 'qq_ha', label: 'qq/ha' },
  { id: 'tn_ha', label: 'tn/ha' },
];

// ── Puente con el flujo de Econometría (inyectado por main.ts) ─────────────
//
// El adapter vive en main.ts porque necesita reutilizar orquestación privada
// del flujo existente (parseo, render de preview/selectores, estado de la
// app). Acá sólo se define el contrato mínimo que Agro necesita consumir.

export interface AgroDatasetLoadParams {
  csvText: string;
  label: string;
  suggestedY?: string;
  suggestedX?: string[];
}

export interface AgroDatasetLoadResult {
  ok: boolean;
  numericColumns: string[];
  message?: string;
}

export interface AgroEconometriaBridge {
  loadDataset(params: AgroDatasetLoadParams): AgroDatasetLoadResult;
}

let bridge: AgroEconometriaBridge | null = null;

// Contexto del preset agro activo: se fija cuando el usuario carga un
// dataset/preset de Agro en Econometría, y se consulta después de una
// corrida real para decidir si corresponde mostrar la lectura agropecuaria.
// Vive en memoria de este módulo (no en appState) para no acoplar el estado
// global de Econometría a Agro.
let activeAgroContext: AgroInterpretationContext | null = null;

let lastMarginInput: AgroMarginInput | null = null;
let lastMarginResult: AgroMarginResult | null = null;

// Dataset generado por "Generar demo grande" (si el usuario lo usó). Vive
// aparte de AGRO_EXAMPLE_DATASETS (que es una lista fija) para no mutar esa
// constante exportada; resolveAgroDataset lo consulta primero.
let generatedDataset: AgroExampleDataset | null = null;

function resolveAgroDataset(id: string): AgroExampleDataset | undefined {
  if (generatedDataset && generatedDataset.id === id) return generatedDataset;
  return getAgroExampleById(id);
}

// Cuenta cuántas de las columnas dadas tienen al menos un valor no numérico
// en el dataset (heurística simple: esas son las que Econometría codifica
// como dummies si se seleccionan como X).
function countCategoricalColumns(dataset: AgroExampleDataset, columns: string[]): number {
  return columns.filter(column => dataset.rows.some(row => typeof row[column] === 'string')).length;
}

function fmtUsd(value: number): string {
  const rounded = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${rounded} USD`;
}

function numberInput(id: string): number {
  const el = $(id) as HTMLInputElement | null;
  if (!el || el.value.trim() === '') return 0;
  return Number(el.value);
}

function buildColumnRoles(detection: AgroColumnDetectionResult, columns: string[]): Record<string, AgroColumnRole> {
  const roles: Record<string, AgroColumnRole> = {};
  for (const column of columns) {
    roles[column] = detection.columns.find(c => c.original === column)?.role ?? 'unknown';
  }
  return roles;
}

function setAgroContextFromSuggestion(
  dataset: AgroExampleDataset,
  detection: AgroColumnDetectionResult,
  suggestion: AgroModelPresetSuggestion
): void {
  const targetRole = detection.columns.find(c => c.original === suggestion.yColumn)?.role ?? suggestion.preset.yRoles[0];
  activeAgroContext = {
    form: suggestion.preset.suggestedForm,
    targetColumn: suggestion.yColumn,
    targetRole,
    columnRoles: buildColumnRoles(detection, suggestion.xColumns),
    crop: dataset.crop,
  };
}

// Sólo para tests: expone si hay un contexto agro activo, sin exponer su
// contenido (evita acoplar los tests a la forma interna del contexto).
export function hasActiveAgroContext(): boolean {
  return activeAgroContext !== null;
}

export function clearAgroContext(): void {
  activeAgroContext = null;
  hideAgroInterpretationPanels();
}

function renderDatasetNote(datasetId: string): void {
  const note = $('qb-agro-dataset-note');
  if (!note) return;
  const dataset = resolveAgroDataset(datasetId);
  if (!dataset) {
    note.textContent = 'Elegí un dataset sintético para ver columnas detectadas y presets sugeridos.';
    return;
  }
  note.innerHTML =
    `<strong>${escapeHtml(dataset.name)}</strong><br>` +
    `${escapeHtml(dataset.description)}<br>` +
    `<span class="muted">${dataset.rows.length} filas · datos 100% sintéticos (no usar para decisiones reales).</span>`;
}

function renderDetection(datasetId: string): void {
  const wrap = $('qb-agro-detection');
  if (!wrap) return;
  const dataset = resolveAgroDataset(datasetId);
  if (!dataset) {
    wrap.innerHTML = '';
    return;
  }

  const detection = detectAgroColumns(dataset.columns);
  const rows = detection.columns
    .map(column => {
      const roleLabel = column.role === 'unknown' ? '—' : agroRoleLabel(column.role);
      const confidence = column.role === 'unknown' ? '' : `${(column.confidence * 100).toFixed(0)}%`;
      return `<tr><td><code>${escapeHtml(column.original)}</code></td>` +
        `<td>${escapeHtml(roleLabel)}</td><td>${confidence}</td></tr>`;
    })
    .join('');
  const warnings = detection.warnings.length
    ? `<p class="muted" style="font-size:11px;margin-top:4px">${detection.warnings.map(escapeHtml).join('<br>')}</p>`
    : '';

  wrap.innerHTML =
    `<p class="qb-label" style="margin-top:12px">Columnas detectadas</p>` +
    `<div class="qb-table-scroll"><table class="ledger">` +
    `<thead><tr><th>Columna</th><th>Rol agro</th><th>Confianza</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>${warnings}`;
}

function renderPresets(datasetId: string): void {
  const wrap = $('qb-agro-presets');
  if (!wrap) return;
  const dataset = resolveAgroDataset(datasetId);
  if (!dataset) {
    wrap.innerHTML = '';
    return;
  }

  const suggestions = suggestAgroModelPresets(detectAgroColumns(dataset.columns));
  if (suggestions.length === 0) {
    wrap.innerHTML = '<p class="muted">No hay presets aplicables para estas columnas.</p>';
    return;
  }

  const cards = suggestions
    .map(suggestion => {
      const missing = suggestion.missingRoles.length
        ? `<br><span class="muted">Roles sin detectar: ${suggestion.missingRoles.map(r => escapeHtml(agroRoleLabel(r))).join(', ')}.</span>`
        : '';
      return (
        `<div class="qb-demo-note" style="margin-top:8px">` +
        `<strong>${escapeHtml(suggestion.preset.label)}</strong> ` +
        `<span class="muted">(score ${(suggestion.score * 100).toFixed(0)} · forma sugerida ${suggestion.preset.suggestedForm})</span><br>` +
        `${escapeHtml(suggestion.reason)}<br>` +
        `Y: <code>${escapeHtml(suggestion.yColumn)}</code> · ` +
        `X: ${suggestion.xColumns.map(x => `<code>${escapeHtml(x)}</code>`).join(', ')}` +
        `${missing}<br>` +
        `<button type="button" class="btn-ink qb-agro-use-preset-btn" style="margin-top:6px" ` +
        `data-agro-preset-id="${escapeHtml(suggestion.preset.id)}">Usar este preset</button>` +
        `</div>`
      );
    })
    .join('');

  wrap.innerHTML =
    `<p class="qb-label" style="margin-top:12px">Presets sugeridos</p>${cards}` +
    `<p class="muted" style="font-size:11px;margin-top:6px">` +
    `"Usar este preset" carga el dataset en Econometría (arriba) y preselecciona Y/X: revisá la ` +
    `selección antes de correr. El motor común de ChartBay hace la regresión; Agro sólo sugiere el modelo.</p>`;
}

function onDatasetChange(): void {
  const select = $('qb-agro-dataset') as HTMLSelectElement | null;
  const datasetId = select?.value ?? '';
  renderDatasetNote(datasetId);
  renderDetection(datasetId);
  renderPresets(datasetId);
}

// ── Cargar dataset/preset en Econometría ────────────────────────────────────

function loadDatasetWithSuggestion(
  dataset: AgroExampleDataset,
  detection: AgroColumnDetectionResult,
  suggestion: AgroModelPresetSuggestion | undefined
): void {
  const statusEl = $('qb-agro-use-status');
  if (!bridge) return;

  const result = bridge.loadDataset({
    csvText: agroDatasetToCsv(dataset),
    label: dataset.name,
    suggestedY: suggestion?.yColumn,
    suggestedX: suggestion?.xColumns,
  });

  if (!result.ok) {
    if (statusEl) statusEl.textContent = result.message ?? 'No se pudo cargar el dataset en Econometría.';
    return;
  }

  if (suggestion) {
    setAgroContextFromSuggestion(dataset, detection, suggestion);
  } else {
    activeAgroContext = null;
  }
  hideAgroInterpretationPanels();

  if (statusEl) {
    if (!suggestion) {
      statusEl.textContent = `"${dataset.name}" cargado en Econometría. Elegí las variables manualmente.`;
      return;
    }
    const categoricalCount = countCategoricalColumns(dataset, suggestion.xColumns);
    const capacity = assessAgroModelCapacity(dataset.rows.length, suggestion.xColumns.length, categoricalCount);
    statusEl.textContent =
      `"${dataset.name}" cargado en Econometría con el preset "${suggestion.preset.label}" preseleccionado ` +
      `(Y = ${suggestion.yColumn}; X = ${suggestion.xColumns.join(', ')}). Revisá la selección antes de correr el modelo. ` +
      capacity.messages.join(' ');
  }
}

function onUseDatasetInEconometria(): void {
  const select = $('qb-agro-dataset') as HTMLSelectElement | null;
  const statusEl = $('qb-agro-use-status');
  const dataset = resolveAgroDataset(select?.value ?? '');
  if (!dataset) {
    if (statusEl) statusEl.textContent = 'Elegí un dataset antes de usarlo en Econometría.';
    return;
  }

  const detection = detectAgroColumns(dataset.columns);
  const suggestions = suggestAgroModelPresets(detection);
  const best = dataset.suggestedPresetId
    ? suggestions.find(s => s.preset.id === dataset.suggestedPresetId) ?? suggestions[0]
    : suggestions[0];

  loadDatasetWithSuggestion(dataset, detection, best);
}

function onPresetsClick(event: Event): void {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-agro-preset-id]');
  if (!button) return;
  const presetId = button.dataset.agroPresetId ?? '';

  const select = $('qb-agro-dataset') as HTMLSelectElement | null;
  const dataset = resolveAgroDataset(select?.value ?? '');
  if (!dataset) return;

  const detection = detectAgroColumns(dataset.columns);
  const suggestion = suggestAgroModelPresets(detection).find(s => s.preset.id === presetId);
  if (!suggestion) return;

  loadDatasetWithSuggestion(dataset, detection, suggestion);
}

// ── Interpretación agropecuaria tras una corrida real ──────────────────────

function renderAgroInterpretationHtml(interpretation: AgroInterpretation): string {
  const list = (items: string[]): string => items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const warningsBlock = interpretation.warnings.length
    ? `<p class="qb-label" style="margin-top:8px">Advertencias</p>` +
      `<ul class="qb-interp" style="margin:4px 0 0;padding-left:18px">${list(interpretation.warnings)}</ul>`
    : '';
  return (
    `<p class="qb-interp">${escapeHtml(interpretation.executiveSummary)}</p>` +
    `<p class="qb-label" style="margin-top:8px">Lectura de coeficientes</p>` +
    `<ul class="qb-interp" style="margin:4px 0 0;padding-left:18px">${list(interpretation.coefficientReadings)}</ul>` +
    `<p class="qb-label" style="margin-top:8px">Lectura agropecuaria</p>` +
    `<p class="qb-interp" style="white-space:pre-line">${escapeHtml(interpretation.agroReading)}</p>` +
    warningsBlock +
    `<p class="qb-label" style="margin-top:8px">Limitaciones</p>` +
    `<ul class="qb-interp" style="margin:4px 0 0;padding-left:18px">${list(interpretation.limitations)}</ul>`
  );
}

function renderInterpretationPanel(panelId: string, contentId: string, interpretation: AgroInterpretation | null): void {
  const panel = $(panelId);
  const content = $(contentId);
  if (!panel || !content) return;
  if (!interpretation) {
    panel.style.display = 'none';
    content.innerHTML = '';
    return;
  }
  content.innerHTML = renderAgroInterpretationHtml(interpretation);
  panel.style.display = '';
}

// Oculta ambos paneles de lectura agropecuaria (Lite y Pro) sin tocar el
// contexto agro activo — se usa al recargar datos o cuando una corrida falla.
export function hideAgroInterpretationPanels(): void {
  renderInterpretationPanel('qb-agro-interpretation-panel', 'qb-agro-interpretation-content', null);
  renderInterpretationPanel('qb-agro-pro-interpretation-panel', 'qb-agro-pro-interpretation-content', null);
}

// Llamado por main.ts tras una corrida exitosa del motor TypeScript (Lite).
// No hace nada (oculta el panel) si no hay contexto agro activo o si la Y de
// la corrida no coincide con la del preset agro elegido — nunca reemplaza la
// interpretación econométrica general, sólo se agrega al lado.
export function presentAgroInterpretationForRegression(
  yName: string,
  result: RegressionResult,
  form: FunctionalForm
): void {
  if (!activeAgroContext || activeAgroContext.targetColumn !== yName) {
    renderInterpretationPanel('qb-agro-interpretation-panel', 'qb-agro-interpretation-content', null);
    return;
  }
  const interpretation = interpretAgroRegressionResult(fromRegressionResult(result, form), activeAgroContext);
  renderInterpretationPanel('qb-agro-interpretation-panel', 'qb-agro-interpretation-content', interpretation);
}

// Idem para el motor Pro (Pyodide / statsmodels). Recibe el resultado real de
// Pro (PyodideOlsResult) a través del tipo estructural AgroPyodideResultLike
// — ver el comentario en agroInterpretation.ts sobre por qué Agro no importa
// pro/pyodide/proResultTypes.ts directamente.
export function presentAgroInterpretationForPro(yName: string, result: AgroPyodideResultLike): void {
  if (!activeAgroContext || activeAgroContext.targetColumn !== yName) {
    renderInterpretationPanel('qb-agro-pro-interpretation-panel', 'qb-agro-pro-interpretation-content', null);
    return;
  }
  const adapted = fromPyodideOlsResult(result);
  const interpretation = adapted ? interpretAgroRegressionResult(adapted, activeAgroContext) : null;
  renderInterpretationPanel('qb-agro-pro-interpretation-panel', 'qb-agro-pro-interpretation-content', interpretation);
}

// ── Simulador de margen ──────────────────────────────────────────────────────

function readMarginInput(): AgroMarginInput {
  const cropValue = ($('qb-agro-m-crop') as HTMLSelectElement | null)?.value ?? 'otro';
  const unitValue = ($('qb-agro-m-unit') as HTMLSelectElement | null)?.value ?? 'kg_ha';
  return {
    crop: (CROPS as string[]).includes(cropValue) ? (cropValue as AgroCrop) : 'otro',
    hectares: numberInput('qb-agro-m-hectares'),
    expectedYield: numberInput('qb-agro-m-yield'),
    yieldUnit: (['kg_ha', 'qq_ha', 'tn_ha'] as string[]).includes(unitValue)
      ? (unitValue as AgroYieldUnit)
      : 'kg_ha',
    expectedPriceUsdPerTon: numberInput('qb-agro-m-price'),
    seedCostUsdPerHa: numberInput('qb-agro-m-seed'),
    fertilizerCostUsdPerHa: numberInput('qb-agro-m-fert'),
    agrochemicalCostUsdPerHa: numberInput('qb-agro-m-agq'),
    laborCostUsdPerHa: numberInput('qb-agro-m-labor'),
    freightCostUsdPerTon: numberInput('qb-agro-m-freight'),
    rentCostUsdPerHa: numberInput('qb-agro-m-rent'),
    otherCostUsdPerHa: numberInput('qb-agro-m-other'),
  };
}

function setMarginExportEnabled(enabled: boolean): void {
  const copyBtn = $('qb-agro-m-copy') as HTMLButtonElement | null;
  const exportBtn = $('qb-agro-m-export-txt') as HTMLButtonElement | null;
  if (copyBtn) copyBtn.disabled = !enabled;
  if (exportBtn) exportBtn.disabled = !enabled;
}

function onMarginRun(): void {
  const errorEl = $('qb-agro-margin-error');
  const resultEl = $('qb-agro-margin-result');
  const copyStatus = $('qb-agro-m-copy-status');
  if (!resultEl) return;

  try {
    const input = readMarginInput();
    const result = calculateAgroMargin(input);
    lastMarginInput = input;
    lastMarginResult = result;
    setMarginExportEnabled(true);
    if (copyStatus) copyStatus.textContent = '';
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }

    const unitLabel = YIELD_UNITS.find(u => u.id === result.breakEvenYieldUnit)?.label ?? result.breakEvenYieldUnit;
    const summaryRows = [
      ['Toneladas totales', `${result.totalTons.toFixed(1)} tn`],
      ['Ingreso bruto', fmtUsd(result.revenueUsd)],
      ['Costo total', fmtUsd(result.totalCostUsd)],
      ['Margen bruto', fmtUsd(result.grossMarginUsd)],
      ['Margen por hectárea', fmtUsd(result.marginPerHectareUsd)],
      ['Rinde de indiferencia', result.breakEvenYield === null ? '—' : `${result.breakEvenYield.toFixed(1)} ${unitLabel}`],
      ['Precio de indiferencia', result.breakEvenPriceUsdPerTon === null ? '—' : `${result.breakEvenPriceUsdPerTon.toFixed(1)} USD/tn`],
    ]
      .map(([label, value]) => `<tr><td>${label}</td><td>${escapeHtml(value)}</td></tr>`)
      .join('');

    const scenarioRows = result.scenarios
      .map(scenario =>
        `<tr><td>${escapeHtml(scenario.label)}</td>` +
        `<td>${scenario.yieldTnHa.toFixed(2)} tn/ha</td>` +
        `<td>${scenario.priceUsdPerTon.toFixed(1)}</td>` +
        `<td>${escapeHtml(fmtUsd(scenario.grossMarginUsd))}</td>` +
        `<td>${escapeHtml(fmtUsd(scenario.marginPerHectareUsd))}</td></tr>`
      )
      .join('');

    const warnings = result.warnings.length
      ? `<div class="qb-interp" style="margin-top:8px">${result.warnings.map(escapeHtml).join('<br>')}</div>`
      : '';

    resultEl.innerHTML =
      `<p class="qb-label" style="margin-top:12px">Resultado (${escapeHtml(result.crop)}, ${result.hectares} ha)</p>` +
      `<div class="qb-table-scroll"><table class="ledger">` +
      `<thead><tr><th>Indicador</th><th>Valor</th></tr></thead><tbody>${summaryRows}</tbody></table></div>` +
      `<p class="qb-label" style="margin-top:10px">Escenarios (±10% rinde y precio)</p>` +
      `<div class="qb-table-scroll"><table class="ledger">` +
      `<thead><tr><th>Escenario</th><th>Rinde</th><th>Precio USD/tn</th><th>Margen bruto</th><th>Margen/ha</th></tr></thead>` +
      `<tbody>${scenarioRows}</tbody></table></div>${warnings}`;
  } catch (err) {
    lastMarginInput = null;
    lastMarginResult = null;
    setMarginExportEnabled(false);
    resultEl.innerHTML = '';
    if (errorEl) {
      errorEl.textContent = `Error en el simulador de margen: ${(err as Error).message}`;
      errorEl.style.display = '';
    }
  }
}

function onMarginCopy(): void {
  const statusEl = $('qb-agro-m-copy-status');
  if (!lastMarginInput || !lastMarginResult) return;
  const text = formatAgroMarginSummary(lastMarginInput, lastMarginResult);
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clipboard?.writeText) {
    clipboard.writeText(text)
      .then(() => { if (statusEl) statusEl.textContent = 'Copiado ✓'; })
      .catch(() => { if (statusEl) statusEl.textContent = 'No se pudo copiar (permisos del navegador).'; });
  } else if (statusEl) {
    statusEl.textContent = 'El navegador no soporta copiar al portapapeles.';
  }
}

function onMarginExportTxt(): void {
  if (!lastMarginInput || !lastMarginResult) return;
  downloadTextFile(
    'chartbay_agro_margen.txt',
    formatAgroMarginSummary(lastMarginInput, lastMarginResult),
    'text/plain'
  );
}

// ── Demo grande (dataset sintético con volumen realista) ───────────────────

// Genera un dataset sintético grande (por defecto 1000 filas: ver
// generateLargeAgroSyntheticDataset) y lo agrega/selecciona en el desplegable
// de datasets, como si fuera uno más — reutiliza todo el flujo de detección,
// presets y carga en Econometría ya existente, sin duplicarlo.
function onGenerateLargeDemo(): void {
  const statusEl = $('qb-agro-generate-status');
  const dataset = generateLargeAgroSyntheticDataset();
  generatedDataset = dataset;

  const select = $('qb-agro-dataset') as HTMLSelectElement | null;
  if (select) {
    let option = select.querySelector<HTMLOptionElement>('option[data-agro-generated="1"]');
    if (!option) {
      option = document.createElement('option');
      option.dataset.agroGenerated = '1';
      select.appendChild(option);
    }
    option.value = dataset.id;
    option.textContent = `${dataset.name} (generado ahora)`;
    select.value = dataset.id;
  }
  onDatasetChange();

  if (statusEl) {
    statusEl.textContent =
      `Se generó "${dataset.name}" con ${dataset.rows.length} filas — 100% sintético. Ya está seleccionado ` +
      `arriba: revisá las columnas detectadas y los presets sugeridos, o usalo directamente en Econometría.`;
  }
}

// ── Datos reales: catálogo de fuentes + templates CSV ──────────────────────
//
// Sección puramente informativa/estática (no depende del dataset elegido).
// No descarga nada: sólo documenta de dónde podría venir un dataset real y
// deja templates CSV listos para copiar/descargar como punto de partida.

function renderAgroDataSources(): void {
  const wrap = $('qb-agro-sources');
  if (!wrap) return;
  wrap.innerHTML = AGRO_DATA_CATALOG.map(source =>
    `<div class="qb-demo-note" style="margin-top:8px">` +
    `<strong>${escapeHtml(source.name)}</strong> — <span class="muted">${escapeHtml(source.provider)}</span><br>` +
    `Granularidad: ${source.granularity.map(escapeHtml).join(' · ')}<br>` +
    `Variables: ${source.variables.map(escapeHtml).join(', ')}<br>` +
    `<span class="muted">${escapeHtml(source.notes)}</span>` +
    `</div>`
  ).join('');
}

function renderAgroCsvTemplates(): void {
  const wrap = $('qb-agro-templates');
  if (!wrap) return;
  wrap.innerHTML = AGRO_CSV_TEMPLATES.map(template =>
    `<div class="qb-demo-note" style="margin-top:8px">` +
    `<strong>${escapeHtml(template.name)}</strong><br>` +
    `${escapeHtml(template.description)}<br>` +
    `Columnas requeridas: ${template.requiredColumns.map(c => `<code>${escapeHtml(c)}</code>`).join(', ')}<br>` +
    `Columnas opcionales: ${template.optionalColumns.map(c => `<code>${escapeHtml(c)}</code>`).join(', ')}<br>` +
    `<button type="button" class="btn-ink qb-agro-template-btn" style="margin-top:6px" ` +
    `data-agro-template-id="${escapeHtml(template.id)}">Descargar template CSV</button>` +
    `</div>`
  ).join('');
}

function onTemplatesClick(event: Event): void {
  const button = (event.target as HTMLElement).closest<HTMLElement>('[data-agro-template-id]');
  if (!button) return;
  const template = AGRO_CSV_TEMPLATES.find(t => t.id === button.dataset.agroTemplateId);
  if (!template) return;
  downloadTextFile(`chartbay_agro_template_${template.id}.csv`, agroCsvTemplateToCsv(template), 'text/csv');
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Inicializa el panel de ChartBay Agro. No-op si el panel no existe en la
// página (así Econometría nunca depende de Agro); oculta el panel si el
// vertical está apagado por flag. `economiaBridge` es la única puerta de
// entrada al flujo existente de Econometría (ver AgroEconometriaBridge arriba).
export function initAgroVertical(
  economiaBridge: AgroEconometriaBridge,
  enabled: boolean = isVerticalEnabled('agro')
): void {
  const panel = $('qb-agro-panel');
  if (!panel) return;
  bridge = economiaBridge;
  if (!enabled) {
    panel.style.display = 'none';
    return;
  }

  const select = $('qb-agro-dataset') as HTMLSelectElement | null;
  if (select && select.options.length === 0) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'Elegí un dataset de ejemplo…';
    select.appendChild(empty);
    for (const dataset of AGRO_EXAMPLE_DATASETS) {
      const option = document.createElement('option');
      option.value = dataset.id;
      option.textContent = dataset.name;
      select.appendChild(option);
    }
    select.addEventListener('change', onDatasetChange);
  }

  const cropSelect = $('qb-agro-m-crop') as HTMLSelectElement | null;
  if (cropSelect && cropSelect.options.length === 0) {
    for (const crop of CROPS) {
      const option = document.createElement('option');
      option.value = crop;
      option.textContent = crop;
      cropSelect.appendChild(option);
    }
  }
  const unitSelect = $('qb-agro-m-unit') as HTMLSelectElement | null;
  if (unitSelect && unitSelect.options.length === 0) {
    for (const unit of YIELD_UNITS) {
      const option = document.createElement('option');
      option.value = unit.id;
      option.textContent = unit.label;
      unitSelect.appendChild(option);
    }
  }

  // Los listeners de click sólo se atan una vez por panel (evita duplicarlos
  // si initAgroVertical se llama más de una vez, p. ej. en tests).
  if (panel.dataset.agroBound !== '1') {
    panel.dataset.agroBound = '1';
    $('qb-agro-use-dataset')?.addEventListener('click', onUseDatasetInEconometria);
    $('qb-agro-presets')?.addEventListener('click', onPresetsClick);
    $('qb-agro-m-run')?.addEventListener('click', onMarginRun);
    $('qb-agro-m-copy')?.addEventListener('click', onMarginCopy);
    $('qb-agro-m-export-txt')?.addEventListener('click', onMarginExportTxt);
    $('qb-agro-generate-large')?.addEventListener('click', onGenerateLargeDemo);
    $('qb-agro-templates')?.addEventListener('click', onTemplatesClick);
  }

  panel.style.display = '';
  renderDatasetNote('');
  renderAgroDataSources();
  renderAgroCsvTemplates();
}
