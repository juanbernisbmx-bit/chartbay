// ChartBay Agro — vista inicial del vertical.
//
// UI mínima y 100% aditiva: si el panel #qb-agro-panel no existe en el HTML o
// el vertical está apagado por flag, initAgroVertical() es un no-op. La UI de
// Econometría no depende de nada de este archivo.

import { $ } from '../../app/dom';
import { escapeHtml } from '../../utils/format';
import { detectAgroColumns } from './agroColumnDetection';
import { AGRO_EXAMPLE_DATASETS, getAgroExampleById } from './agroExamples';
import { isVerticalEnabled } from './agroFeatureFlags';
import { agroRoleLabel, suggestAgroModelPresets } from './agroModelPresets';
import { calculateAgroMargin } from './agroMargin';
import type { AgroCrop, AgroMarginInput, AgroYieldUnit } from './agroTypes';

const CROPS: AgroCrop[] = ['soja', 'maiz', 'trigo', 'girasol', 'sorgo', 'cebada', 'otro'];
const YIELD_UNITS: Array<{ id: AgroYieldUnit; label: string }> = [
  { id: 'kg_ha', label: 'kg/ha' },
  { id: 'qq_ha', label: 'qq/ha' },
  { id: 'tn_ha', label: 'tn/ha' },
];

function fmtUsd(value: number): string {
  const rounded = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${rounded} USD`;
}

function numberInput(id: string): number {
  const el = $(id) as HTMLInputElement | null;
  if (!el || el.value.trim() === '') return 0;
  return Number(el.value);
}

function renderDatasetNote(datasetId: string): void {
  const note = $('qb-agro-dataset-note');
  if (!note) return;
  const dataset = getAgroExampleById(datasetId);
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
  const dataset = getAgroExampleById(datasetId);
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
  const dataset = getAgroExampleById(datasetId);
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
        `${missing}</div>`
      );
    })
    .join('');

  wrap.innerHTML =
    `<p class="qb-label" style="margin-top:12px">Presets sugeridos</p>${cards}` +
    `<p class="muted" style="font-size:11px;margin-top:6px">` +
    `Para estimar cualquiera de estos modelos, cargá el CSV en Econometría (arriba): ` +
    `Agro sugiere el modelo, el motor común de ChartBay hace la regresión.</p>`;
}

function onDatasetChange(): void {
  const select = $('qb-agro-dataset') as HTMLSelectElement | null;
  const datasetId = select?.value ?? '';
  renderDatasetNote(datasetId);
  renderDetection(datasetId);
  renderPresets(datasetId);
}

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

function onMarginRun(): void {
  const errorEl = $('qb-agro-margin-error');
  const resultEl = $('qb-agro-margin-result');
  if (!resultEl) return;

  try {
    const result = calculateAgroMargin(readMarginInput());
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
    resultEl.innerHTML = '';
    if (errorEl) {
      errorEl.textContent = `Error en el simulador de margen: ${(err as Error).message}`;
      errorEl.style.display = '';
    }
  }
}

// Inicializa el panel de ChartBay Agro. No-op si el vertical está apagado o
// el panel no existe en la página (así Econometría nunca depende de Agro).
export function initAgroVertical(enabled: boolean = isVerticalEnabled('agro')): void {
  const panel = $('qb-agro-panel');
  if (!panel) return;
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

  $('qb-agro-m-run')?.addEventListener('click', onMarginRun);

  panel.style.display = '';
  renderDatasetNote('');
}
