export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );

export function significanceBadge(pValue: number): string {
  if (pValue < 0.01) return '<span class="sig-badge sig-h">*** p&lt;0.01</span>';
  if (pValue < 0.05) return '<span class="sig-badge sig-m">** p&lt;0.05</span>';
  if (pValue < 0.10) return '<span class="sig-badge sig-l">* p&lt;0.10</span>';
  return '<span class="sig-badge sig-n">n.s.</span>';
}

export function significanceLabel(pValue: number): string {
  if (pValue < 0.01) return '***';
  if (pValue < 0.05) return '**';
  if (pValue < 0.10) return '*';
  return 'n.s.';
}

export function correlationClass(value: number, isDiagonal: boolean): string {
  if (isDiagonal) return 'corr-diag';
  if (value >= 0.7) return 'corr-sp';
  if (value <= -0.7) return 'corr-sn';
  if (value >= 0.3) return 'corr-mp';
  if (value <= -0.3) return 'corr-mn';
  return 'corr-w';
}
