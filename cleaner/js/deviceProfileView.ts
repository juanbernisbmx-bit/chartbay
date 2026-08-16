/**
 * The "Device & Processing Profile" panel.
 *
 * Framework-free DOM, matching the rest of ChartBay's front end. Two layers on
 * purpose: a short summary anyone can read, and a collapsed block with the
 * numbers only someone debugging would want.
 *
 * The tone rule for this panel: every figure here except the file size is an
 * estimate, and the copy says so. A confident-looking "8 GB RAM" would be a
 * lie — the browser reports a clamped power of two, and never reports free
 * memory at all.
 */

import type { DeviceProfile, MemoryBudget } from './deviceProfiler';
import {
  MODE_LABEL,
  formatMB,
  type PreflightResult,
  type ProcessingMode,
  type ProcessingStatus,
} from './preflight';
import { SLOW_PROCESSING_WARNING_SECONDS } from './processingLimits';

const STATUS_LABEL: Record<ProcessingStatus, string> = {
  safe: 'SEGURO',
  warning: 'ATENCIÓN',
  'not-recommended': 'NO RECOMENDADO',
  blocked: 'BLOQUEADO',
};

export interface ViewModel {
  profile: DeviceProfile;
  budget: MemoryBudget;
  preflight?: PreflightResult;
  /** Mode the user picked. Defaults to preflight's recommendation. */
  mode?: ProcessingMode;
  onModeChange?: (mode: ProcessingMode) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function row(label: string, value: string): HTMLElement {
  const line = el('div', 'cb-profile__row');
  line.append(el('span', 'cb-profile__label', label), el('span', 'cb-profile__value', value));
  return line;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s`;
  return `~${Math.round(seconds / 60)} min`;
}

function memoryLine(profile: DeviceProfile): string {
  if (profile.estimatedDeviceMemoryGB === undefined) return 'no informada por el navegador';
  if (profile.memoryOverrideApplied) return `${profile.estimatedDeviceMemoryGB} GB`;
  // Saying "8 GB" flat would misrepresent a clamped value.
  if (profile.estimatedDeviceMemoryGB >= 8) return '8 GB o más (aprox.)';
  return `~${profile.estimatedDeviceMemoryGB} GB (aprox.)`;
}

export function renderDeviceProfile(container: HTMLElement, model: ViewModel): void {
  const { profile, budget, preflight } = model;
  const mode = model.mode ?? preflight?.recommendedMode ?? 'standard-clean';
  const recommendation = preflight?.recommendations[mode];
  const status: ProcessingStatus = recommendation?.status ?? 'safe';

  container.textContent = '';
  container.classList.add('cb-profile');

  const header = el('div', 'cb-profile__header');
  header.append(el('h3', 'cb-profile__title', 'Dispositivo y procesamiento'));
  const badge = el('span', `cb-profile__badge cb-profile__badge--${status}`, STATUS_LABEL[status]);
  header.append(badge);
  container.append(header);

  // ── Summary: what a normal user needs ──
  const summary = el('div', 'cb-profile__summary');
  summary.append(row('Memoria del equipo', memoryLine(profile)));
  if (profile.logicalCores !== undefined) {
    summary.append(row('Núcleos', String(profile.logicalCores)));
  }
  summary.append(row('Memoria reservada', formatMB(budget.targetMemoryBytes)));
  summary.append(row('Tamaño de bloque', formatMB(budget.recommendedChunkBytes)));

  if (preflight) {
    summary.append(row('Archivo', formatMB(preflight.file.fileBytes)));
    summary.append(
      row(
        'Filas estimadas',
        preflight.file.exact
          ? preflight.file.estimatedRows.toLocaleString('es-AR')
          : `~${preflight.file.estimatedRows.toLocaleString('es-AR')}`
      )
    );
    summary.append(row('Modo', MODE_LABEL[mode]));
    if (recommendation && recommendation.estimatedSeconds > SLOW_PROCESSING_WARNING_SECONDS) {
      summary.append(row('Duración estimada', formatDuration(recommendation.estimatedSeconds)));
    }
  }
  container.append(summary);

  if (recommendation) {
    container.append(el('p', 'cb-profile__reason', recommendation.reason));
  }

  // ── Mode picker, with each option carrying its own verdict ──
  if (preflight && model.onModeChange) {
    const picker = el('div', 'cb-profile__modes');
    for (const candidate of Object.keys(preflight.recommendations) as ProcessingMode[]) {
      const item = preflight.recommendations[candidate];
      const button = el('button', 'cb-profile__mode');
      button.type = 'button';
      button.dataset.status = item.status;
      button.setAttribute('aria-pressed', String(candidate === mode));
      if (candidate === mode) button.classList.add('is-selected');
      button.append(
        el('span', 'cb-profile__mode-name', MODE_LABEL[candidate]),
        el('span', 'cb-profile__mode-status', STATUS_LABEL[item.status])
      );
      button.addEventListener('click', () => model.onModeChange?.(candidate));
      picker.append(button);
    }
    container.append(picker);
  }

  // ── Technical details, collapsed ──
  const details = el('details', 'cb-profile__details');
  details.append(el('summary', 'cb-profile__details-toggle', 'Detalles técnicos'));

  const grid = el('div', 'cb-profile__grid');
  grid.append(row('Presupuesto de memoria', formatMB(budget.targetMemoryBytes)));
  grid.append(row('Máximo antes de abortar', formatMB(budget.maxMemoryBytes)));
  grid.append(row('Confianza de la estimación', budget.confidence));
  grid.append(row('Cómo se calculó', budget.reason));
  grid.append(row('WebAssembly', profile.wasmSupported ? 'disponible' : 'no disponible'));
  grid.append(row('Web Workers', profile.workersSupported ? 'disponibles' : 'no disponibles'));
  grid.append(row('Direccionamiento WASM', 'wasm32, 4 GB máximo'));
  if (profile.browser) grid.append(row('Navegador', profile.browser));
  if (profile.platform) grid.append(row('Plataforma', profile.platform));
  if (profile.jsHeapLimitBytes !== undefined) {
    grid.append(row('Tope del heap JS', formatMB(profile.jsHeapLimitBytes)));
  }

  const apis = Object.entries(profile.availableApis)
    .map(([name, present]) => `${name}: ${present ? 'sí' : 'no'}`)
    .join(' · ');
  grid.append(row('APIs disponibles', apis));

  if (preflight) {
    grid.append(row('Bytes por fila (muestra)', Math.round(preflight.file.averageRowBytes) + ' B'));
    grid.append(row('Columnas', String(preflight.file.columnCount)));
    grid.append(
      row(
        'Forma estimada',
        `${preflight.file.shape.numeric} num · ${preflight.file.shape.date} fecha · ` +
          `${preflight.file.shape.categorical} cat · ${preflight.file.shape.text} texto`
      )
    );
    for (const candidate of Object.keys(preflight.recommendations) as ProcessingMode[]) {
      const item = preflight.recommendations[candidate];
      grid.append(
        row(
          `Memoria — ${MODE_LABEL[candidate]}`,
          `${formatMB(item.estimatedMemoryBytes)} (${STATUS_LABEL[item.status]})`
        )
      );
    }
  }
  details.append(grid);

  const caveat = el(
    'p',
    'cb-profile__caveat',
    'Todas las cifras de memoria son estimaciones. El navegador no puede informar ' +
      'la RAM libre real del sistema, así que se usan las señales que expone y se ' +
      'redondea siempre hacia el lado conservador.'
  );
  details.append(caveat);
  container.append(details);
}
