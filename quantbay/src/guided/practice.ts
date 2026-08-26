// Modo práctica: la recomendación, retenida y convertida en pregunta.
//
// No hay un segundo motor pedagógico acá. El plan es exactamente el mismo que
// en modo guiado; lo único que cambia es el orden en que el estudiante ve las
// cosas: primero se compromete con una respuesta, después lee la de la guía.
// Por eso este archivo es puro y no decide nada de econometría — solo elige
// qué pasos ofrecer y arma el contraste con textos que ya están escritos.
//
// Frontera importante: acá NO se corrige. La guía ordena pasos, no dictamina
// econometría, así que una respuesta distinta no es un error. Lo que se
// devuelve es qué habría sugerido la guía y para qué sirve lo que eligió el
// estudiante; el juicio queda del lado de él.

import { stepDefinition } from './steps';
import type {
  GuidedPlan, PracticeOption, PracticeQuestion, PracticeReveal, StepKey,
} from './types';

/** Cuántas opciones se ofrecen. Más que esto deja de ser una pregunta. */
export const MAX_PRACTICE_OPTIONS = 4;

/**
 * Ventana de `size` elementos que contiene a `index`, pegada a los bordes
 * cuando no hay lugar de un lado.
 *
 * Elige QUÉ pasos se ofrecen: los vecinos del recomendado en el orden canónico
 * son los distractores plausibles. En qué orden se muestran lo decide después
 * `shuffle`.
 */
function windowAround<T>(items: T[], index: number, size: number): T[] {
  if (items.length <= size) return items;
  const start = Math.max(0, Math.min(index - Math.floor((size - 1) / 2), items.length - size));
  return items.slice(start, start + size);
}

function optionOf(step: StepKey): PracticeOption {
  return { step, title: stepDefinition(step).prompt.title };
}

/** FNV-1a. Solo hace falta que sea estable y que disperse. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Orden de las opciones: derivado del id de la pregunta, no del azar ni del
 * orden canónico.
 *
 * Sin esto la respuesta caía casi siempre en la misma posición —la ventana
 * está centrada en el paso recomendado—, y el modo terminaba enseñando a
 * adivinar por posición en vez de a pensar qué sigue. El orden canónico
 * tampoco sirve: la recomendación suele ser el primer paso pendiente, así que
 * se acertaría sin leer.
 *
 * Sigue siendo determinista: la misma pregunta se dibuja siempre igual, que es
 * lo que permite testearla y lo que evita que las opciones se muevan solas
 * debajo del cursor en cada redibujo.
 */
function shuffle(options: PracticeOption[], seed: string): PracticeOption[] {
  return [...options].sort((a, b) => hash(seed + a.step) - hash(seed + b.step));
}

/**
 * La pregunta que corresponde al plan actual, o null si no hay ninguna honesta
 * que hacer.
 *
 * Devuelve null cuando no hay recomendación que retener, cuando el paso
 * recomendado ya está hecho —preguntar por algo resuelto sería una trampa— o
 * cuando queda una sola opción posible: una pregunta con una sola respuesta no
 * practica nada.
 */
export function buildPracticeQuestion(plan: GuidedPlan): PracticeQuestion | null {
  if (!plan.primary) return null;

  const recommended = plan.primary.targetStep;
  // Pasos todavía en juego. Los completados y los que no aplican no se
  // ofrecen: serían distractores que el estudiante puede descartar sin pensar.
  const candidates = plan.steps.filter(s => s.state !== 'done' && s.state !== 'not_applicable');
  const index = candidates.findIndex(s => s.key === recommended);
  if (index < 0 || candidates.length < 2) return null;

  const id = plan.primary.id;
  const options = windowAround(candidates, index, MAX_PRACTICE_OPTIONS).map(s => optionOf(s.key));
  return {
    id,
    prompt: '¿Qué conviene hacer ahora?',
    options: shuffle(options, id),
    recommended,
  };
}

/**
 * El contraste entre lo que eligió el estudiante y lo que la guía iba a decir.
 *
 * Todos los textos vienen de piezas ya revisadas: el título, el cuerpo y el
 * porqué salen de la recomendación retenida; el "para qué sirve" del paso
 * elegido sale del catálogo. No se redacta veredicto nuevo acá, que es la
 * forma de no inventar afirmaciones econométricas en la capa de presentación.
 */
export function buildPracticeReveal(
  plan: GuidedPlan,
  question: PracticeQuestion,
  chosen: StepKey
): PracticeReveal | null {
  if (!plan.primary) return null;
  const chosenStep = plan.steps.find(s => s.key === chosen);
  const definition = stepDefinition(chosen);
  return {
    matched: chosen === question.recommended,
    recommendedTitle: plan.primary.title,
    recommendedBody: plan.primary.body,
    recommendedWhy: plan.primary.why,
    chosenLabel: definition.label,
    chosenWhy: definition.prompt.why,
    // Un dato, no una opinión: el paso elegido puede ser razonable y todavía
    // no estar disponible. Decir qué falta es más útil que decir que estuvo mal.
    chosenBlocked: chosenStep?.state === 'blocked' && chosenStep.unmet.length > 0
      ? chosenStep.unmet[0].describe
      : null,
  };
}
