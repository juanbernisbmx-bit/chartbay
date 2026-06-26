import { escapeHtml } from '../utils/format';

export const $ = (id: string): HTMLElement | null => document.getElementById(id);

export function showError(msg: string): void {
  const el = $('qb-error');
  if (!el) return;
  el.innerHTML = msg ? escapeHtml(msg).replace(/\n/g, '<br>') : '';
  el.style.display = msg ? '' : 'none';
}

export function setMethodStatus(method: string): void {
  setText('qb-status-method', method);
  const badge = document.querySelector<HTMLElement>('#qb-results .qb-panel-head span');
  if (badge) badge.textContent = method;
}

export function updateSidebarStep(stepNum: number): void {
  document.querySelectorAll<HTMLAnchorElement>('.qb-sidebar a').forEach((link, i) => {
    link.style.fontWeight = (i + 1 === stepNum) ? '700' : '';
    link.style.opacity = (i + 1 <= stepNum) ? '1' : '0.45';
  });
}

export function setText(id: string, value: string | number): void {
  const el = $(id);
  if (el) el.textContent = String(value);
}

export function setEngineStatus(value: string): void {
  setText('qb-status-engine', value);
}

export function writeRunLog(lines: string[]): void {
  const log = $('qb-runlog');
  if (!log) return;
  log.innerHTML = lines.map(line => `<div>${escapeHtml(line)}</div>`).join('');
}
