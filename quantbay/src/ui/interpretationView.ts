import type { InterpretationResult } from '../interpretation/types';
import { escapeHtml } from '../utils/format';

const severityLabel: Record<InterpretationResult['severity'], string> = {
  positive: 'Conclusión favorable',
  warning: 'Requiere atención',
  neutral: 'Lectura contextual',
  critical: 'Resultado no fiable',
};

export function renderInterpretationResults(items: InterpretationResult[]): string {
  if (items.length === 0) return '';
  return `
    <section class="qb-auto-interpretation" aria-label="Interpretación automática de ChartBay">
      <p class="qb-label">INTERPRETACIÓN DE CHARTBAY</p>
      <p class="muted qb-help">Reglas determinísticas aplicadas a los resultados calculados. No modifican ni reemplazan los valores numéricos.</p>
      ${items.map((item, index) => {
        const theory = item.theoryConcepts.length
          ? `<p class="qb-theory-links"><strong>Ver teoría:</strong> ${item.theoryConcepts.map(id => `<a href="/guia#${encodeURIComponent(id)}">${escapeHtml(id.replace(/^teoria-/, '').replace(/-/g, ' '))}</a>`).join(' · ')}</p>`
          : '';
        const steps = item.nextSteps.length
          ? `<div class="qb-interp-next"><strong>Siguiente paso:</strong><ul>${item.nextSteps.map(step => `<li>${escapeHtml(step.label)}${step.rationale ? ` — ${escapeHtml(step.rationale)}` : ''}</li>`).join('')}</ul></div>`
          : '';
        const limitations = item.limitations.length
          ? `<details class="qb-interp-details"><summary>Limitaciones</summary><ul>${item.limitations.map(value => `<li>${escapeHtml(value)}</li>`).join('')}</ul></details>`
          : '';
        return `<article class="qb-interp-result qb-interp-${item.severity}">
          <details${index === 0 ? ' open' : ''}>
            <summary><strong>${escapeHtml(item.title)}</strong> <span>${escapeHtml(severityLabel[item.severity])}</span></summary>
            <div class="qb-interp-result-body">
              <p><strong>Conclusión breve:</strong> ${escapeHtml(item.summary)}</p>
              ${item.statisticalConclusion ? `<p><strong>Conclusión estadística:</strong> ${escapeHtml(item.statisticalConclusion)}</p>` : ''}
              ${item.practicalMeaning ? `<p><strong>Qué significa:</strong> ${escapeHtml(item.practicalMeaning)}</p>` : ''}
              ${steps}${limitations}${theory}
            </div>
          </details>
        </article>`;
      }).join('')}
    </section>`;
}
