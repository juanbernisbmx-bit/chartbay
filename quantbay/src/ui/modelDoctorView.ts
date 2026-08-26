import type { DoctorFinding, DoctorReport } from '../modelDoctor/types';
import { noteDoctorReport } from '../guided/session';
import { escapeHtml } from '../utils/format';

const OVERALL_LABEL: Record<DoctorReport['overallState'], string> = {
  attention: 'Requiere atención',
  review: 'Requiere revisión',
  clear: 'Sin señales relevantes',
  partial: 'Diagnóstico parcial',
};

const STATE_LABEL: Record<DoctorFinding['state'], string> = {
  ok: 'sin señales relevantes',
  review: 'revisar',
  problem: 'evidencia de problema',
  mitigated: 'atendido por el modelo',
  insufficient: 'sin evaluar',
  not_applicable: 'no aplica',
};

const CATEGORY_LABEL: Record<DoctorFinding['category'], string> = {
  sample: 'Datos y muestra',
  specification: 'Especificación',
  residuals: 'Residuos',
  inference: 'Inferencia',
  heteroskedasticity: 'Heterocedasticidad',
  multicollinearity: 'Multicolinealidad',
  globalSignificance: 'Significancia global',
  restrictions: 'Restricciones',
  stationarity: 'Estacionariedad',
  serialCorrelation: 'Autocorrelación',
  modelIdentification: 'Identificación temporal',
  arimaResiduals: 'Residuos del ARIMA',
  forecast: 'Pronóstico',
  stability: 'Estabilidad',
  other: 'Otro diagnóstico',
};

function renderFinding(finding: DoctorFinding, open = false): string {
  const evidence = finding.detail.evidence.length > 0
    ? `<dl class="qb-doctor-evidence">${finding.detail.evidence
      .map(line => `<div><dt>${escapeHtml(line.label)}</dt><dd>${escapeHtml(line.value)}</dd></div>`)
      .join('')}</dl>`
    : '<p>No hay un estadístico adicional disponible para este eje.</p>';
  const checks = finding.detail.whatToCheck.length > 0
    ? `<ol>${finding.detail.whatToCheck.map(item => `<li>${escapeHtml(item.text)}${item.cost ? `<span class="muted"> Costo: ${escapeHtml(item.cost)}</span>` : ''}</li>`).join('')}</ol>`
    : '<p>No requiere una acción inmediata; conservá este resultado como contexto.</p>';
  const doesNot = finding.detail.whatItDoesNot.length > 0
    ? `<ul>${finding.detail.whatItDoesNot.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
    : '<p>No permite concluir que el modelo sea correcto ni que sus relaciones sean causales.</p>';
  const theory = finding.detail.theory.length > 0
    ? `<p class="qb-theory-links">${finding.detail.theory
      .map(link => `<a href="/guia#${encodeURIComponent(link.id)}">${escapeHtml(link.label)}</a>`)
      .join(' · ')}</p>`
    : '<p>No hay un concepto adicional vinculado para este eje.</p>';

  return `<details class="qb-doctor-finding qb-doctor-${finding.state}"${open ? ' open' : ''}>
    <summary>
      <span class="qb-doctor-category">${escapeHtml(CATEGORY_LABEL[finding.category])}</span>
      <span class="qb-doctor-chip qb-doctor-chip-${finding.state}">${escapeHtml(STATE_LABEL[finding.state])}</span>
    </summary>
    <div class="qb-doctor-detail">
      <p class="qb-doctor-finding-headline">${escapeHtml(finding.headlineText)}</p>
      <section><h4>1 · Evidencia</h4>${evidence}</section>
      <section><h4>2 · Conclusión estadística</h4><p>${escapeHtml(finding.detail.conclusion)}</p></section>
      <section><h4>3 · Por qué importa</h4><p>${escapeHtml(finding.detail.whyItMatters)}</p></section>
      <section><h4>4 · Qué revisar</h4>${checks}</section>
      <section><h4>5 · Qué NO significa</h4>${doesNot}</section>
      <section><h4>6 · Confianza del diagnóstico</h4><p>${escapeHtml(finding.detail.confidenceNote)}</p></section>
      <section><h4>7 · Teoría</h4>${theory}</section>
    </div>
  </details>`;
}

export function renderModelDoctor(report: DoctorReport): string {
  // Econometría Guiada consume este mismo informe para traducir hallazgos en
  // próximos pasos. Se deposita acá porque es el punto por donde pasan los
  // cuatro caminos que construyen uno, y así la guía no lo reconstruye.
  noteDoctorReport(report);

  const candidates = report.findings.filter(finding => finding.state !== 'ok' && finding.state !== 'not_applicable');
  const actionable = candidates.filter(finding => finding.state === 'problem' || finding.state === 'review' || finding.state === 'mitigated');
  const unavailable = candidates.filter(finding => finding.state === 'insufficient');
  const orderedCandidates = [...actionable, ...unavailable];
  const visible = orderedCandidates.slice(0, 5);
  const other = orderedCandidates.find(finding => finding.category === 'other');
  if (other && !visible.includes(other)) visible.splice(Math.max(0, visible.length - 1), 1, other);
  const okCount = report.findings.filter(finding => finding.state === 'ok').length;
  const headline = report.headline?.headlineText
    ?? actionable[0]?.headlineText
    ?? (report.overallState === 'partial'
      ? 'La cobertura o la potencia disponible no alcanzan para un diagnóstico firme.'
      : 'No se encontraron señales relevantes en los ejes que pudieron evaluarse.');
  const rows = visible.map((finding, index) => renderFinding(finding, index === 0)).join('');
  const okRow = okCount > 0
    ? `<div class="qb-doctor-ok-summary"><span>${okCount} ${okCount === 1 ? 'categoría sin señales relevantes' : 'categorías sin señales relevantes'}</span><span class="qb-doctor-chip qb-doctor-chip-ok">${STATE_LABEL.ok}</span></div>`
    : '';
  const limits = `<details class="qb-doctor-limits">
    <summary>Qué no puede decirte este diagnóstico</summary>
    <ul>${report.limits.map(limit => `<li>${escapeHtml(limit)}</li>`).join('')}</ul>
  </details>`;

  return `<section class="qb-model-doctor qb-model-doctor-${report.overallState}" aria-label="Model Doctor">
    <div class="qb-doctor-header">
      <div>
        <p class="qb-label">MODEL DOCTOR</p>
        <p class="qb-doctor-overall">${escapeHtml(OVERALL_LABEL[report.overallState])}</p>
      </div>
      <span class="qb-doctor-coverage">${report.coverage.evaluated} de ${report.coverage.applicable} evaluadas</span>
    </div>
    <p class="qb-doctor-headline"><strong>Principal hallazgo:</strong> ${escapeHtml(headline)}</p>
    <div class="qb-doctor-findings">${rows}${okRow}</div>
    ${limits}
  </section>`;
}
