import type { FunctionalFormRecommendation } from '../services/formRecommender';
import type { FunctionalForm } from '../functionalForms';
import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';

export const FORM_LABELS: Record<FunctionalForm, string> = {
  'lin-lin': 'Lin-Lin',
  'log-lin': 'Log-Lin',
  'lin-log': 'Lin-Log',
  'log-log': 'Log-Log',
};

export function renderFormRecommendation(rec: FunctionalFormRecommendation | null): void {
  const empty = $('qb-form-rec-empty');
  const panel = $('qb-form-rec-result');
  const content = $('qb-form-rec-content');
  const applyBtn = $('qb-form-apply') as HTMLButtonElement | null;

  if (!rec) {
    if (empty) empty.style.display = '';
    if (panel) panel.style.display = 'none';
    return;
  }

  if (empty) empty.style.display = 'none';
  if (panel) panel.style.display = '';
  if (!content) return;

  // Sort valid candidates by RMSE ascending for display
  const validSorted = rec.candidates
    .filter(c => c.valid && c.metrics)
    .sort((a, b) => a.metrics!.rmseOriginalScale - b.metrics!.rmseOriginalScale);

  const invalidCandidates = rec.candidates.filter(c => !c.valid);

  let html = '';

  if (rec.recommended) {
    const best = rec.candidates.find(c => c.form === rec.recommended);
    html += `<p style="margin:0 0 4px"><strong>Forma sugerida: ${FORM_LABELS[rec.recommended]}</strong></p>`;
    const imp = best?.metrics?.improvementVsLinLin;
    if (imp !== undefined && imp > 0.05) {
      html += `<p class="qb-interp" style="margin:0 0 6px;font-size:12px">`;
      html += `${FORM_LABELS[rec.recommended]} reduce el RMSE en escala original un ${imp.toFixed(1)}% frente a Lin-Lin.</p>`;
    }
  } else {
    html += `<p class="muted" style="margin:0 0 6px">No se pudo determinar una forma recomendada con los datos actuales.</p>`;
  }

  if (rec.warning) {
    html += `<p class="qb-interp" style="margin:0 0 6px;font-size:12px;color:#f2c94c">${escapeHtml(rec.warning)}</p>`;
  }

  html += `<div class="qb-table-scroll">`;
  html += `<table class="ledger" style="font-size:12px;margin-top:4px">`;
  html += `<thead><tr><th>#</th><th>Forma</th><th>RMSE (orig.)</th><th>MAE (orig.)</th><th>R² aj.</th></tr></thead>`;
  html += `<tbody>`;

  validSorted.forEach((c, i) => {
    const isRec = c.form === rec.recommended;
    html += `<tr${isRec ? ' style="font-weight:600"' : ''}>`;
    html += `<td>${i + 1}</td>`;
    html += `<td>${FORM_LABELS[c.form]}</td>`;
    html += `<td>${c.metrics!.rmseOriginalScale.toFixed(3)}</td>`;
    html += `<td>${c.metrics!.maeOriginalScale.toFixed(3)}</td>`;
    html += `<td>${c.metrics!.adjustedRSquared.toFixed(4)}</td>`;
    html += `</tr>`;
  });

  invalidCandidates.forEach(c => {
    html += `<tr>`;
    html += `<td>—</td><td>${FORM_LABELS[c.form]}</td>`;
    html += `<td colspan="3" class="muted" style="font-size:11px">${escapeHtml(c.reasonIfInvalid ?? 'Inválido.')}</td>`;
    html += `</tr>`;
  });

  html += `</tbody></table></div>`;
  html += `<p class="muted" style="font-size:11px;margin:8px 0 0">${escapeHtml(rec.note)}</p>`;

  content.innerHTML = html;

  if (applyBtn) {
    applyBtn.style.display = rec.recommended ? '' : 'none';
    applyBtn.dataset.form = rec.recommended ?? '';
  }
}
