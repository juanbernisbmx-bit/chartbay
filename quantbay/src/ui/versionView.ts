import type { ChartBayVersionConfig } from '../versioning/chartbayVersions';
import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';

const ENGINE_LABELS: Record<ChartBayVersionConfig['engine'], string> = {
  typescript: 'TypeScript en navegador',
  pyodide: 'Pyodide / Python en navegador',
};

const STATUS_LABELS: Record<ChartBayVersionConfig['status'], string> = {
  available: 'Disponible',
  beta: 'Beta',
  locked: 'Próximamente',
};

export function renderVersionInfo(config: ChartBayVersionConfig): void {
  const engine = $('qb-version-engine');
  const limit = $('qb-version-limit');
  const status = $('qb-version-status');
  const beta = $('qb-version-beta');
  const desc = $('qb-version-desc');
  const select = $('qb-version') as HTMLSelectElement | null;

  if (select) select.value = config.id;
  if (engine) engine.textContent = ENGINE_LABELS[config.engine];
  if (limit) limit.textContent = `${config.maxCsvSizeMb} MB`;
  if (status) status.textContent = STATUS_LABELS[config.status];
  if (beta) beta.hidden = config.status !== 'beta';
  if (desc) desc.innerHTML = escapeHtml(config.description);
}
