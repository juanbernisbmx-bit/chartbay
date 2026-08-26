// Vista de Econometría Guiada.
//
// No decide nada: dibuja el plan que arma el planificador. Si acá aparece una
// condición sobre datos o un umbral, está en la capa equivocada.

import { $ } from '../app/dom';
import { escapeHtml } from '../utils/format';
import { buildAnalysisContext, suggestAnalysisType } from '../guided/context';
import { buildGuidedPlan } from '../guided/planner';
import {
  acknowledgeStep, answerPractice, confirmAnalysisType, dismissRecommendation,
  getPracticeAnswer, getSession, logDecision, noteSpecChange, recordEstimation,
  restoreGuidedPreferences, seedSpecBaseline, setMode,
} from '../guided/session';
import { buildPracticeQuestion, buildPracticeReveal } from '../guided/practice';
import type { GuidedMode, PracticeQuestion } from '../guided/types';
import { subscribeComparisonStore } from '../modelComparison/store';
import { buildDecisionLogText, clockOf } from '../guided/decisionLog';
import { downloadTextFile } from './exports';
import type { DecisionKind, GuidedPlan, GuidedSession, GuidedStep, Recommendation, StepState } from '../guided/types';

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

/**
 * El registro se dibuja plegado y el panel se redibuja entero en cada cambio,
 * así que si el desplegado no se recordara acá, se cerraría solo cada vez que
 * el estudiante toca cualquier control.
 */
let logOpen = false;

/** Etiqueta de la clase de decisión, para poder leer el registro de un vistazo. */
const DECISION_LABEL: Record<DecisionKind, string> = {
  load: 'datos',
  choose_type: 'tipo',
  choose_variables: 'variables',
  set_spec: 'especificación',
  estimate: 'estimación',
  acknowledge_step: 'revisión',
  dismiss_recommendation: 'omisión',
  set_mode: 'modo',
  compare_models: 'contraste',
  practice_answer: 'práctica',
};

const MODE_LABEL: Record<GuidedMode, string> = {
  guided: 'guiado',
  free: 'libre',
  practice: 'práctica',
};
const MODES: GuidedMode[] = ['guided', 'free', 'practice'];

/**
 * Modelos guardados que la guía ya anotó, para registrar altas y bajas.
 *
 * Se observa el store en vez de tocar el panel de comparación: así el módulo
 * de contraste no tiene que saber que la guía existe, y el registro se entera
 * igual de que el estudiante guardó o descartó una especificación.
 */
let knownSaved = new Map<string, string>();

/**
 * initGuided registra listeners en `document` y una suscripción al store de
 * comparación: cosas que viven mientras viva la página. Llamarlo dos veces
 * las duplicaría, así que se hace una sola vez, igual que el panel de
 * comparación de al lado.
 */
let initialized = false;

/**
 * Solo para tests: la memoria de guardados es de la vista, no del store.
 *
 * No toca `initialized` a propósito: la suscripción ya registrada tiene que
 * seguir viva, y volver a suscribirse es justamente lo que el flag evita.
 */
export function resetGuidedViewForTests(): void {
  knownSaved = new Map();
  logOpen = false;
}

function noteComparisonChanges(saved: Array<{ id: string; name?: string }>): void {
  const next = new Map(saved.map(model => [model.id, model.name ?? 'una estimación']));
  for (const [id, name] of next) {
    if (!knownSaved.has(id)) logDecision('compare_models', `Guardaste ${name} para comparar`);
  }
  for (const [id, name] of knownSaved) {
    if (!next.has(id)) logDecision('compare_models', `Quitaste ${name} de la comparación`);
  }
  knownSaved = next;
}

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

/**
 * Registro de decisiones.
 *
 * Más reciente primero, al revés que en el archivo exportado: en pantalla lo
 * que importa es qué acaba de pasar; leído de corrido fuera de la app, el
 * orden cronológico es el que cuenta la sesión.
 *
 * Se muestra en los dos modos. En libre es lo único que queda: sin riel y sin
 * consejos, es la única forma de que el estudiante pueda reconstruir después
 * qué decidió.
 */
function decisionLog(session: GuidedSession): string {
  if (session.decisions.length === 0) return '';
  const items = session.decisions
    .slice()
    .reverse()
    .map(d => `
      <li class="qb-g-dec">
        <time>${escapeHtml(clockOf(d.at))}</time>
        <span class="qb-g-dec-kind">${escapeHtml(DECISION_LABEL[d.kind] ?? d.kind)}</span>
        <span class="qb-g-dec-text">${escapeHtml(d.summary)}</span>
      </li>`)
    .join('');
  return `
    <details class="qb-g-log"${logOpen ? ' open' : ''}>
      <summary data-guided-log="1">Registro de decisiones · ${session.decisions.length}</summary>
      <ul class="qb-g-decs">${items}</ul>
      <div class="qb-g-actions">
        <button type="button" class="qb-g-skip" data-guided-export="1">Descargar registro</button>
      </div>
    </details>`;
}

function downloadDecisionLog(): void {
  const ctx = buildAnalysisContext();
  const text = buildDecisionLogText(ctx.session, {
    dataset: ctx.dataset?.name ?? null,
    analysisType: ctx.session.confirmedType,
    mode: ctx.session.mode,
    generatedAt: Date.now(),
  });
  downloadTextFile('chartbay_registro_decisiones.md', text, 'text/markdown');
}

/**
 * La pregunta, mientras el estudiante no se haya comprometido con nada.
 *
 * No se dibuja el porqué ni el título de la recomendación: eso es justamente
 * lo que se está reteniendo.
 */
function practiceQuestionBlock(question: PracticeQuestion): string {
  const options = question.options
    .map(option => `<li><button type="button" class="qb-g-opt" data-practice-q="${escapeHtml(question.id)}" data-practice-step="${option.step}">${escapeHtml(option.title)}</button></li>`)
    .join('');
  return `
    <div class="qb-g-rec qb-g-rec--practice">
      <p class="qb-g-kind">Modo práctica</p>
      <p class="qb-g-title">${escapeHtml(question.prompt)}</p>
      <ul class="qb-g-opts">${options}</ul>
    </div>`;
}

/**
 * La devolución. Contrasta, no corrige.
 *
 * Coincidir no valida nada y no coincidir no es un error: la guía ordena
 * pasos, no dictamina econometría. Por eso el texto dice qué habría sugerido
 * y para qué sirve lo elegido, y deja el juicio del lado del estudiante.
 */
function practiceRevealBlock(plan: GuidedPlan, question: PracticeQuestion, chosen: string): string {
  const reveal = buildPracticeReveal(plan, question, chosen as never);
  if (!reveal) return '';
  const blocked = reveal.chosenBlocked
    ? `<p class="qb-g-unmet qb-g-unmet--block">Ahora mismo ese paso no se puede: falta ${escapeHtml(reveal.chosenBlocked)}.</p>`
    : '';
  const yours = reveal.matched
    ? '<p class="qb-g-body">Elegiste lo mismo que iba a sugerir la guía. Coincidir no valida el análisis: la guía ordena pasos, no dictamina econometría.</p>'
    : `<p class="qb-g-body"><strong>Elegiste ${escapeHtml(reveal.chosenLabel)}.</strong> ${escapeHtml(reveal.chosenWhy)}</p>${blocked}
       <p class="qb-g-body">No es un error: puede haber razones para ese orden. Lo que sigue es lo que la guía iba a proponer y por qué.</p>`;
  return `
    <div class="qb-g-rec qb-g-rec--practice">
      <p class="qb-g-kind">${reveal.matched ? 'Coincidieron' : 'Lo tuyo y lo de la guía'}</p>
      ${yours}
      <p class="qb-g-title">${escapeHtml(reveal.recommendedTitle)}</p>
      <p class="qb-g-body">${escapeHtml(reveal.recommendedBody)}</p>
      <details class="qb-g-why" open>
        <summary>¿Por qué?</summary>
        <p>${escapeHtml(reveal.recommendedWhy)}</p>
        ${theoryLinks(plan.primary?.theory ?? [])}
      </details>
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
  const ctx = buildAnalysisContext();
  // Barato y idempotente: solo hace algo cuando todavía no hay línea de base,
  // que es justo después de cargar un dataset.
  seedSpecBaseline(ctx.spec);
  const plan: GuidedPlan = buildGuidedPlan(ctx);
  const free = session.mode === 'free';
  const prompt = typePrompt();

  // Práctica: el tipo de análisis ya es una pregunta con la decisión del lado
  // del estudiante, así que ese prompt se deja pasar tal cual y la retención
  // empieza recién con las recomendaciones.
  const question = session.mode === 'practice' && !prompt ? buildPracticeQuestion(plan) : null;
  const answered = question ? getPracticeAnswer(question.id) : null;
  const pending = question !== null && answered === null;

  // Mientras la pregunta esté abierta el riel no se dibuja: el chip
  // "siguiente" contestaría solo. Vuelve apenas el estudiante se compromete.
  const rail = plan.steps.length > 0 && !free && !pending
    ? `<ol class="qb-g-steps">${plan.steps.map(stepRow).join('')}</ol>`
    : '';

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
  const practiceBody = question
    ? (answered
        ? practiceRevealBlock(plan, question, answered)
        : practiceQuestionBlock(question))
    : null;

  // El contador de secundarias también adelanta cuánto falta: se guarda hasta
  // que la pregunta esté contestada.
  const more = plan.secondary.length > 0 && !free && !pending
    ? `<p class="qb-g-more">${plan.secondary.length} sugerencia(s) más</p>`
    : '';

  host.innerHTML = `
    <div class="qb-g-head">
      <p class="qb-subtitle">Análisis guiado</p>
      <span class="qb-g-modes">${MODES.map(mode => mode === session.mode
        ? `<span class="qb-g-mode is-active" aria-current="true">${MODE_LABEL[mode]}</span>`
        : `<button type="button" class="qb-g-mode" data-guided-mode="${mode}">${MODE_LABEL[mode]}</button>`
      ).join('')}</span>
    </div>
    ${rail}
    ${practiceBody ?? visibleBody}
    ${more}
    ${decisionLog(session)}`;
  host.style.display = '';
}

/**
 * Un solo listener delegado en el contenedor: la vista se redibuja entera en
 * cada cambio, así que enganchar botón por botón dejaría listeners colgados.
 */
/**
 * Controles cuyo cambio puede alterar el plan. La guía engancha los suyos en
 * vez de pedirle a main.ts que la avise: así sumar un control nuevo no obliga
 * a tocar el punto de entrada.
 */
const REFRESH_ON_CHANGE = [
  'qb-ts-date', 'qb-ts-value', 'qb-ts-transform',
  'qb-pro-ts-arima-enable', 'qb-pro-ts-arima-p', 'qb-pro-ts-arima-d', 'qb-pro-ts-arima-q',
];
const REFRESH_ON_CLICK = ['qb-ts-run', 'qb-pro-ts-run'];

export function initGuided(onAction?: (focus: string) => void): void {
  const host = $('qb-guided');
  if (!host || initialized) return;
  initialized = true;

  // El modo elegido sobrevive a recargar la página. Se restaura antes del
  // primer dibujo para que el panel no aparezca guiado y salte a libre.
  restoreGuidedPreferences();

  // Un solo listener delegado y ninguna lista de controles que mantener: se
  // escucha `change` en el documento y se deja que noteSpecChange decida si
  // algo de la especificación se movió. Cambiar un control ajeno no anota
  // nada porque la firma no cambia.
  //
  // `change` y no `input`: escribir una restricción letra por letra es una
  // decisión, no veinte. Y diferido, porque los handlers de la app corren
  // después y appState todavía tiene el valor anterior.
  document.addEventListener('change', () => setTimeout(() => {
    noteSpecChange(buildAnalysisContext().spec);
    renderGuided();
  }, 0));

  // Guardar o quitar una especificación cambia el plan (G11, G12, G13) y es
  // una decisión que va al registro. Se escucha el store, no los botones.
  subscribeComparisonStore(state => {
    noteComparisonChanges(state.saved);
    renderGuided();
  });

  // Diferido: estos listeners se registran después que los de la app, pero el
  // resultado recién existe cuando el handler original terminó.
  const refreshLater = () => setTimeout(() => renderGuided(), 0);
  for (const id of REFRESH_ON_CHANGE) $(id)?.addEventListener('change', refreshLater);
  // Al correr una serie hay que anotar con qué especificación se produjo el
  // resultado; si no, cambiar la transformación después no invalida nada y el
  // ADF de la serie anterior queda en pantalla como si correspondiera.
  for (const id of REFRESH_ON_CLICK) {
    $(id)?.addEventListener('click', () => setTimeout(() => {
      const signature = buildAnalysisContext().spec?.signature;
      if (signature) recordEstimation(signature);
      renderGuided();
    }, 0));
  }

  host.addEventListener('click', event => {
    const el = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-guided-type],[data-guided-skip],[data-guided-act],[data-guided-mode],[data-guided-log],[data-guided-export],[data-practice-q]');
    if (!el) return;

    if (el.dataset.practiceQ !== undefined) {
      answerPractice(el.dataset.practiceQ, el.dataset.practiceStep as never, el.textContent?.trim() ?? '');
    } else if (el.dataset.guidedLog !== undefined) {
      // El <details> se abre solo por el click nativo, pero el redibujo de
      // abajo reemplaza el nodo entero: hay que recordarlo acá o se cierra.
      logOpen = !logOpen;
    } else if (el.dataset.guidedExport !== undefined) {
      downloadDecisionLog();
    } else if (el.dataset.guidedType) {
      const ctx = buildAnalysisContext();
      const suggested = suggestAnalysisType(ctx.dataset)?.type ?? null;
      confirmAnalysisType(el.dataset.guidedType as 'cross_section' | 'time_series', suggested);
    } else if (el.dataset.guidedSkip) {
      dismissRecommendation(el.dataset.guidedSkip, el.dataset.guidedTitle ?? '');
    } else if (el.dataset.guidedMode) {
      const mode = el.dataset.guidedMode as GuidedMode;
      if (MODES.includes(mode)) setMode(mode);
    } else if (el.dataset.guidedAct !== undefined) {
      const step = el.dataset.guidedStep;
      if (step) acknowledgeStep(step as never, el.textContent?.trim() ?? step, el.dataset.guidedRec);
      const focus = el.dataset.guidedAct;
      if (focus && onAction) onAction(focus);
    }
    renderGuided();
  });
}
