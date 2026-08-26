// Planificador: contexto → plan. Función pura.
//
// No lee el DOM ni estado global, así que se puede testear sin navegador y
// dos sesiones con las mismas acciones producen exactamente el mismo plan.
// La vista no toma ninguna decisión pedagógica: solo dibuja lo que sale de acá.

import { GUIDED_RULES, type GuidedRule } from './rules';
import { STEP_DEFINITIONS, isStale, type StepDefinition } from './steps';
import type {
  AnalysisContext,
  GuidedPlan,
  GuidedStep,
  Recommendation,
  StepKey,
  StepState,
} from './types';

/** Cuántas recomendaciones secundarias se muestran junto a la principal. */
export const MAX_SECONDARY = 3;

function flowOf(ctx: AnalysisContext): 'cross_section' | 'time_series' {
  if (ctx.session.confirmedType === 'time_series') return 'time_series';
  if (ctx.session.confirmedType === 'cross_section') return 'cross_section';
  return ctx.mode === 'timeseries' ? 'time_series' : 'cross_section';
}

function appliesToFlow(def: StepDefinition, flow: 'cross_section' | 'time_series'): boolean {
  return def.appliesTo.includes(flow);
}

/**
 * Estado de un paso, sin considerar todavía cuál es el próximo sugerido: eso
 * se decide después, mirando el conjunto.
 */
function baseState(def: StepDefinition, ctx: AnalysisContext): { state: StepState; unmet: GuidedStep['unmet'] } {
  const unmet = def.requirements.filter(r => !r.test(ctx));

  // Los requisitos se miran ANTES que la completitud: un paso no puede estar
  // hecho si sus prerrequisitos no se cumplen, aunque su condición de
  // completitud dé verdadera por casualidad. Elegir Y y X antes de confirmar
  // el tipo de análisis no cuenta como haber elegido variables para el modelo
  // que todavía no se decidió.
  if (unmet.length > 0) return { state: 'blocked', unmet };
  if (def.isComplete(ctx)) return { state: 'done', unmet: [] };
  return { state: def.kind === 'optional' ? 'optional' : 'pending', unmet: [] };
}

function evaluateRules(ctx: AnalysisContext): Recommendation[] {
  return GUIDED_RULES
    .filter((rule: GuidedRule) => {
      if (ctx.session.dismissed.includes(rule.id)) return false;
      try {
        return rule.when(ctx);
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.priority - a.priority)
    .map(rule => rule.build(ctx));
}

const KIND_RANK: Record<Recommendation['kind'], number> = {
  blocking: 0,
  advisory: 1,
  optional: 2,
  informational: 3,
};

export function buildGuidedPlan(ctx: AnalysisContext): GuidedPlan {
  const flow = flowOf(ctx);

  // El flujo de series todavía no tiene sus pasos (etapa 5 del roadmap). En
  // vez de mostrar medio recorrido de corte transversal —que sería
  // directamente incorrecto para una serie— se dice que no hay guía todavía.
  if (flow === 'time_series') {
    return {
      steps: STEP_DEFINITIONS.filter(d => appliesToFlow(d, 'time_series')).map(def => {
        const { state, unmet } = baseState(def, ctx);
        return { key: def.key, label: def.label, kind: def.kind, state, unmet, theory: def.theory };
      }),
      primary: null,
      secondary: [],
      nextStep: null,
      blocked: false,
      cannotAdvise: {
        reason: 'El recorrido guiado para series de tiempo todavía no está disponible.',
        whatIsMissing: 'Las herramientas de series funcionan igual desde el panel de Time Series; lo que falta es la guía paso a paso.',
      },
    };
  }

  const steps: GuidedStep[] = STEP_DEFINITIONS
    .filter(def => appliesToFlow(def, flow))
    .map(def => {
      const { state, unmet } = baseState(def, ctx);
      return { key: def.key, label: def.label, kind: def.kind, state, unmet, theory: def.theory };
    });

  // Desactualizado: el paso se hizo, pero un cambio río arriba lo dejó viejo.
  // No se re-estima solo; se marca y se espera al estudiante.
  if (isStale(ctx)) {
    for (const step of steps) {
      if (step.key === 'estimate' && step.state !== 'blocked') {
        step.state = 'review';
        step.reviewReason = 'stale';
      }
    }
  }

  const recommendations = evaluateRules(ctx);
  const blocking = recommendations.filter(r => r.kind === 'blocking');

  // Pasos sobre los que el estudiante ya dijo "continuar igualmente". Sin
  // esto, descartar una recomendación hacía aparecer el prompt del mismo paso
  // con el mismo texto, y el botón parecía no hacer nada.
  const passedOver = new Set(
    GUIDED_RULES.filter(r => ctx.session.dismissed.includes(r.id)).map(r => r.targetStep)
  );

  // El próximo paso: el primer pendiente del orden canónico. Si hay algo
  // bloqueante, el foco es resolverlo, no avanzar.
  const nextStep: StepKey | null = blocking.length > 0
    ? blocking[0].targetStep
    : steps.find(s => (s.state === 'pending' || s.state === 'review') && !passedOver.has(s.key))?.key ?? null;

  if (nextStep) {
    const target = steps.find(s => s.key === nextStep);
    if (target && target.state === 'pending') target.state = 'next';
  }

  // Prioridad: bloqueantes primero; después por tipo y por prioridad de regla,
  // que ya viene aplicada en el orden de `recommendations`.
  const ordered = [...recommendations].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

  // Si no hay regla que hable, la recomendación es el prompt del próximo paso.
  let primary: Recommendation | null = ordered[0] ?? null;
  if (!primary && nextStep && !passedOver.has(nextStep)) {
    const def = STEP_DEFINITIONS.find(d => d.key === nextStep);
    if (def) {
      primary = {
        id: `step:${def.key}`,
        ruleId: 'STEP',
        kind: 'advisory',
        targetStep: def.key,
        title: def.prompt.title,
        body: def.prompt.body,
        why: def.prompt.why,
        actions: [],
        theory: def.theory,
        dismissible: false,
      };
    }
  }

  const secondary = ordered.filter(r => r !== primary).slice(0, MAX_SECONDARY);

  const plan: GuidedPlan = {
    steps,
    primary,
    secondary,
    nextStep,
    blocked: blocking.length > 0,
  };

  // Nada que recomendar y nada hecho: el dataset no da para un análisis.
  if (!primary && !ctx.dataset) {
    plan.cannotAdvise = {
      reason: 'No hay información suficiente para recomendar un próximo paso.',
      whatIsMissing: 'Cargá un CSV para empezar.',
    };
  }

  return plan;
}
