// Vista de Econometría Guiada.
//
// No decide nada: dibuja el plan que arma el planificador. Si acá aparece una
// condición sobre datos o un umbral, está en la capa equivocada.

import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import { buildAnalysisContext, suggestAnalysisType } from '../guided/context';
import { buildGuidedPlan } from '../guided/planner';
import {
  acknowledgeStep, confirmAnalysisType, dismissRecommendation, getSession, setMode,
} from '../guided/session';
import type { GuidedPlan, GuidedStep, Recommendation, StepState } from '../guided/types';

const STATE_LABEL: Record<StepState, string> = {
  done: 'completado',
  next: 'siguiente',
  pending: 'pendiente',
  review: 'requiere revisión',
  optional: 'opcional',
  not_applicable: 'no aplica',
  blocked: 'bloqueado',
};

/** Los estados que no son de progreso llevan marca cuadrada, para leerse sin color. */
const SQUARE_STATES: StepState[] = ['blocked', 'pending', 'optional', 'not_applicable'];

const THEORY_LABEL: Record<string, string> = {
  'OLS': 'OLS',
  'modelo y datos': 'modelo y datos',
  'supuestos y sesgo': 'supuestos y sesgo',
  't y p-value': 't y p-valor',
  'IC y F': 'intervalos y F',
  'errores robustos': 'errores robustos',
  'Breusch-Pagan': 'Breusch-Pagan',
  'estacionariedad': 'estacionariedad',
  'ADF': 'ADF',
  'ACF/PACF': 'ACF y PACF',
  'ARIMA': 'ARIMA',
  'pregunta econometrica': 'la pregunta econométrica',
};

function stepRow(step: GuidedStep, index: number): string {
  const shape = SQUARE_STATES.includes(step.state) ? ' qb-g-chip--sq' : '';
  const reason = step.reviewReason === 'stale' ? ' · cambió la especificación' : '';
  const blocked = step.state === 'blocked' && step.unmet.length > 0
    ? `<p class="qb-g-unmet">Falta ${escapeHtml(step.unmet[0].describe)}.</p>`
    : '';
  return `
    <li class="qb-g-step qb-g-step--${step.state}">
      <span class="qb-g-n">${index + 1}</span>
      <span class="qb-g-label">${escapeHtml(step.label)}</span>
      <span class="qb-g-chip qb-g-chip--${step.state}${shape}">${STATE_LABEL[step.state]}${escapeHtml(reason)}</span>
      ${blocked}
    </li>`;
}

function theoryLinks(keys: string[]): string {
  if (keys.length === 0) return '';
  const links = keys
    .map(k => `<a href="/guia#${encodeURIComponent(k)}" target="_blank" rel="noopener">${escapeHtml(THEORY_LABEL[k] ?? k)}</a>`)
    .join(' · ');
  return `<p class="qb-g-theory">Teoría: ${links}</p>`;
}

function recommendationBlock(rec: Recommendation): string {
  const kindLabel = rec.kind === 'blocking' ? 'Antes de continuar' : 'Recomendación actual';
  const actions = rec.actions
    .map(a => `<button type="button" class="btn-ink qb-g-act" data-guided-act="${escapeHtml(a.focus ?? '')}" data-guided-step="${rec.targetStep}" data-guided-rec="${escapeHtml(rec.id)}">${escapeHtml(a.label)}</button>`)
    .join('');
  const skip = rec.dismissible
    ? `<button type="button" class="qb-g-skip" data-guided-skip="${escapeHtml(rec.id)}" data-guided-title="${escapeHtml(rec.title)}">Continuar igualmente</button>`
    : '';
  return `
    <div class="qb-g-rec qb-g-rec--${rec.kind}">
      <p class="qb-g-kind">${kindLabel}</p>
      <p class="qb-g-title">${escapeHtml(rec.title)}</p>
      <p class="qb-g-body">${escapeHtml(rec.body)}</p>
      <details class="qb-g-why">
        <summary>¿Por qué?</summary>
        <p>${escapeHtml(rec.why)}</p>
        ${theoryLinks(rec.theory)}
      </details>
      <div class="qb-g-actions">${actions}${skip}</div>
    </div>`;
}

function typePrompt(): string {
  const ctx = buildAnalysisContext();
  const suggestion = suggestAnalysisType(ctx.dataset);
  if (!suggestion || ctx.session.confirmedType) return '';
  const label = suggestion.type === 'time_series' ? 'series de tiempo' : 'corte transversal';
  const other = suggestion.type === 'time_series' ? 'cross_section' : 'time_series';
  const otherLabel = other === 'time_series' ? 'series de tiempo' : 'corte transversal';
  return `
    <div class="qb-g-rec qb-g-rec--advisory">
      <p class="qb-g-kind">Confirmá el tipo de análisis</p>
      <p class="qb-g-title">Parece ${escapeHtml(label)}</p>
      <p class="qb-g-body">Lo sugiero porque ${escapeHtml(suggestion.evidence)}. La decisión es tuya.</p>
      <div class="qb-g-actions">
        <button type="button" class="btn-ink" data-guided-type="${suggestion.type}">Confirmar ${escapeHtml(label)}</button>
        <button type="button" class="qb-g-skip" data-guided-type="${other}">Usar ${escapeHtml(otherLabel)}</button>
      </div>
    </div>`;
}

export function renderGuided(): void {
  const host = $('qb-guided');
  if (!host) return;

  const session = getSession();
  const plan: GuidedPlan = buildGuidedPlan(buildAnalysisContext());
  const free = session.mode === 'free';

  const rail = plan.steps.length > 0 && !free
    ? `<ol class="qb-g-steps">${plan.steps.map(stepRow).join('')}</ol>`
    : '';

  const prompt = typePrompt();
  const body = prompt
    || (plan.cannotAdvise
      ? `<div class="qb-g-rec qb-g-rec--informational">
           <p class="qb-g-kind">Sin recomendación</p>
           <p class="qb-g-title">${escapeHtml(plan.cannotAdvise.reason)}</p>
           <p class="qb-g-body">${escapeHtml(plan.cannotAdvise.whatIsMissing)}</p>
         </div>`
      : plan.primary ? recommendationBlock(plan.primary) : '');

  // En modo libre solo emergen las bloqueantes: lo que invalidaría el trabajo.
  const visibleBody = free && plan.primary?.kind !== 'blocking' && !prompt ? '' : body;
  const more = plan.secondary.length > 0 && !free
    ? `<p class="qb-g-more">${plan.secondary.length} sugerencia(s) más</p>`
    : '';

  host.innerHTML = `
    <div class="qb-g-head">
      <p class="qb-subtitle">Análisis guiado</p>
      <button type="button" class="qb-g-mode" data-guided-mode="${free ? 'guided' : 'free'}">
        modo ${free ? 'libre' : 'guiado'} · cambiar
      </button>
    </div>
    ${rail}
    ${visibleBody}
    ${more}`;
  host.style.display = '';
}

/**
 * Un solo listener delegado en el contenedor: la vista se redibuja entera en
 * cada cambio, así que enganchar botón por botón dejaría listeners colgados.
 */
export function initGuided(onAction?: (focus: string) => void): void {
  const host = $('qb-guided');
  if (!host) return;

  host.addEventListener('click', event => {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-guided-type],[data-guided-skip],[data-guided-act],[data-guided-mode]');
    if (!el) return;

    if (el.dataset.guidedType) {
      const ctx = buildAnalysisContext();
      const suggested = suggestAnalysisType(ctx.dataset)?.type ?? null;
      confirmAnalysisType(el.dataset.guidedType as 'cross_section' | 'time_series', suggested);
    } else if (el.dataset.guidedSkip) {
      dismissRecommendation(el.dataset.guidedSkip, el.dataset.guidedTitle ?? '');
    } else if (el.dataset.guidedMode) {
      setMode(el.dataset.guidedMode === 'free' ? 'free' : 'guided');
    } else if (el.dataset.guidedAct !== undefined) {
      const step = el.dataset.guidedStep;
      if (step) acknowledgeStep(step as never, el.textContent?.trim() ?? step, el.dataset.guidedRec);
      const focus = el.dataset.guidedAct;
      if (focus && onAction) onAction(focus);
    }
    renderGuided();
  });
}
