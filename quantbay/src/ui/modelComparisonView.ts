import { compareModels } from '../modelComparison/engine';
import {
  getComparisonStoreState,
  removeComparisonModel,
  renameComparisonModel,
  saveCurrentComparisonModel,
  startComparisonDataset,
  subscribeComparisonStore,
} from '../modelComparison/store';
import type { CoefficientComparisonRow, ModelComparisonResult, ModelSnapshot } from '../modelComparison/types';
import { setCurrentComparisonModel } from '../modelComparison/store';
import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';

type ComparisonFilter = 'all' | 'common' | 'changed' | 'metrics' | 'diagnostics';
let activeFilter: ComparisonFilter = 'all';
let initialized = false;

const DOCTOR_LABELS: Record<string, string> = {
  sample: 'Muestra', specification: 'Especificación', residuals: 'Residuos', inference: 'Inferencia',
  heteroskedasticity: 'Heterocedasticidad', multicollinearity: 'Multicolinealidad',
  globalSignificance: 'Significancia global', restrictions: 'Restricciones', stationarity: 'Estacionariedad',
  serialCorrelation: 'Correlación serial', modelIdentification: 'Identificación', arimaResiduals: 'Residuos ARIMA',
  forecast: 'Pronóstico', stability: 'Estabilidad', other: 'Otros',
};
const DOCTOR_STATE_LABELS: Record<string, string> = {
  ok: 'Correcto', review: 'Revisar', problem: 'Problema', mitigated: 'Mitigado',
  insufficient: 'Sin evaluar', not_applicable: 'No aplica',
};

function fmt(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return Math.abs(value) >= 1e6 || (Math.abs(value) > 0 && Math.abs(value) < 1e-4)
    ? value.toExponential(3)
    : value.toFixed(digits);
}

function modelName(model: ModelSnapshot, index: number): string {
  return model.name || `Modelo ${index + 1}`;
}

function coefficientCell(row: CoefficientComparisonRow, modelId: string): string {
  const coefficient = row.cells.find(cell => cell.modelId === modelId)?.coefficient;
  if (!coefficient) return '<span class="qb-comparison-absent">— No incluida</span>';
  const interval = coefficient.confidenceInterval
    ? `[${fmt(coefficient.confidenceInterval[0])}; ${fmt(coefficient.confidenceInterval[1])}]`
    : '—';
  return `<span class="qb-comparison-beta">β ${fmt(coefficient.estimate)}</span><small>EE ${fmt(coefficient.stdError)} · p ${fmt(coefficient.pValue)}<br>IC95% ${interval}</small>`;
}

function tableHead(models: ModelSnapshot[]): string {
  return `<tr><th>Indicador</th>${models.map((model, index) => `<th>${escapeHtml(modelName(model, index))}</th>`).join('')}</tr>`;
}

function renderCoefficientTable(result: ModelComparisonResult): string {
  if (activeFilter === 'metrics' || activeFilter === 'diagnostics') return '';
  const rows = result.coefficientRows.filter(row => {
    if (activeFilter === 'common') return row.presentInAll;
    if (activeFilter === 'changed') return row.changed || row.significanceChanged;
    return true;
  });
  if (!rows.length) return '<p class="muted qb-help">No hay coeficientes para el filtro seleccionado.</p>';
  return `<p class="qb-label">Coeficientes e inferencia</p><div class="qb-table-scroll"><table class="ledger qb-comparison-table">
    <thead>${tableHead(result.models)}</thead><tbody>${rows.map(row => `<tr><td><strong>${escapeHtml(row.label)}</strong>${row.significanceChanged ? '<span class="qb-comparison-tag">cambia significancia</span>' : ''}</td>${result.models.map(model => `<td>${coefficientCell(row, model.id)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function metricValue(value: number | string | null, key: string): string {
  if (typeof value === 'number') return key === 'nObs' || key === 'regressorCount' ? String(value) : fmt(value);
  return value === null ? '—' : escapeHtml(value);
}

function renderMetricTable(result: ModelComparisonResult): string {
  if (activeFilter === 'diagnostics') return '';
  return `<p class="qb-label">Especificación y ajuste</p><div class="qb-table-scroll"><table class="ledger qb-comparison-table">
    <thead>${tableHead(result.models)}</thead><tbody>${result.metricRows.map(row => `<tr${row.comparable ? '' : ' class="qb-comparison-muted"'}><td>${escapeHtml(row.label)}${row.comparable ? '' : '<small>No comparable</small>'}</td>${row.values.map(value => `<td>${metricValue(value, row.key)}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

function renderDoctorTable(result: ModelComparisonResult): string {
  if (activeFilter === 'metrics') return '';
  if (!result.diagnosticRows.length) return '';
  return `<p class="qb-label">Model Doctor por categoría</p><p class="muted qb-help">Estados consumidos directamente del informe de cada estimación.</p><div class="qb-table-scroll"><table class="ledger qb-comparison-table">
    <thead>${tableHead(result.models)}</thead><tbody>${result.diagnosticRows.map(row => `<tr><td>${escapeHtml(DOCTOR_LABELS[row.category] ?? row.category)}</td>${row.values.map(value => `<td>${value ? `<span class="qb-comparison-state qb-comparison-state-${value}">${escapeHtml(DOCTOR_STATE_LABELS[value] ?? value)}</span>` : '—'}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

export function renderModelComparisonHtml(result: ModelComparisonResult): string {
  const status = result.comparability.level === 'direct' ? 'Comparación directa' : result.comparability.level === 'caution' ? 'Comparar con cautela' : 'Comparación directa bloqueada';
  const warnings = result.comparability.warnings.length
    ? `<div class="qb-comparison-warnings"><strong>${escapeHtml(status)}</strong>${result.comparability.warnings.map(item => `<p>${escapeHtml(item.message)}</p>`).join('')}</div>`
    : `<p class="qb-comparison-ok">${status}: misma variable dependiente, escala, muestra y familia.</p>`;
  const differences = result.differences.length || result.coefficientChanges.length
    ? `<details class="qb-comparison-details"><summary>Qué cambió entre especificaciones</summary><ul>${result.differences.map(item => `<li>${escapeHtml(item.text)}</li>`).join('')}${result.coefficientChanges.map(item => `<li>${escapeHtml(item.text)}</li>`).join('')}</ul><p>Estas diferencias son descriptivas. No prueban causalidad ni seleccionan automáticamente un modelo.</p></details>`
    : '';
  return `${warnings}${differences}${renderCoefficientTable(result)}${renderMetricTable(result)}${renderDoctorTable(result)}`;
}

function renderSavedModels(models: ModelSnapshot[]): string {
  if (!models.length) return '<p class="muted qb-help">Todavía no guardaste estimaciones. Los modelos se conservan solo durante esta sesión.</p>';
  return models.map((model, index) => `<div class="qb-comparison-saved">
    <span><strong>${escapeHtml(modelName(model, index))}</strong><small>${escapeHtml(model.specification.dependentVariable)} · ${escapeHtml(model.specification.functionalForm ?? model.specification.family)} · n=${model.metrics.nObs ?? '—'}</small></span>
    <span><button type="button" class="btn-ink" data-comparison-action="rename" data-model-id="${escapeHtml(model.id)}">Renombrar</button><button type="button" class="btn-ink" data-comparison-action="remove" data-model-id="${escapeHtml(model.id)}">Quitar</button></span>
  </div>`).join('');
}

export function renderModelComparisonView(): void {
  const section = $('qb-model-comparison');
  const currentEl = $('qb-comparison-current');
  const savedEl = $('qb-comparison-saved');
  const output = $('qb-comparison-output');
  const saveButton = $('qb-comparison-save') as HTMLButtonElement | null;
  if (!section || !currentEl || !savedEl || !output) return;
  const state = getComparisonStoreState();
  section.style.display = state.current || state.saved.length ? '' : 'none';
  currentEl.textContent = state.current
    ? `Lista para guardar: ${state.current.specification.dependentVariable} · ${state.current.specification.functionalForm ?? state.current.specification.family} · n=${state.current.metrics.nObs ?? '—'}`
    : 'Calculá una regresión para habilitar el guardado.';
  if (saveButton) saveButton.disabled = !state.current;
  savedEl.innerHTML = renderSavedModels(state.saved);
  output.innerHTML = state.saved.length >= 2
    ? renderModelComparisonHtml(compareModels(state.saved))
    : '<p class="muted qb-help">Guardá al menos dos estimaciones para compararlas.</p>';
}

export function beginModelComparisonDataset(label?: string): string {
  return startComparisonDataset(label);
}

export function captureCurrentModel(snapshot: ModelSnapshot): ModelSnapshot {
  return setCurrentComparisonModel(snapshot);
}

export function initModelComparisonView(): void {
  if (initialized) return;
  initialized = true;
  $('qb-comparison-save')?.addEventListener('click', () => {
    const input = $('qb-comparison-name') as HTMLInputElement | null;
    saveCurrentComparisonModel(input?.value);
    if (input) input.value = '';
  });
  $('qb-comparison-filter')?.addEventListener('change', event => {
    activeFilter = (event.target as HTMLSelectElement).value as ComparisonFilter;
    renderModelComparisonView();
  });
  $('qb-comparison-saved')?.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-comparison-action]');
    if (!button) return;
    const id = button.dataset.modelId ?? '';
    if (button.dataset.comparisonAction === 'remove') removeComparisonModel(id);
    if (button.dataset.comparisonAction === 'rename') {
      const current = getComparisonStoreState().saved.find(model => model.id === id);
      const name = window.prompt('Nuevo nombre del modelo:', current?.name ?? '');
      if (name !== null) renameComparisonModel(id, name);
    }
  });
  subscribeComparisonStore(renderModelComparisonView);
  renderModelComparisonView();
}
