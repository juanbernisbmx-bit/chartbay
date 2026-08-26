// Planificador: contexto → plan. Función pura.
//
// No lee el DOM ni estado global, así que se puede testear sin navegador y
// dos sesiones con las mismas acciones producen exactamente el mismo plan.
// La vista no toma ninguna decisión pedagógica: solo dibuja lo que sale de acá.

import { GUIDED_RULES, type GuidedRule } from './rules';
import { STEP_DEFINITIONS, isStale, type StepDefinition } from './steps';
import { changedFields, invalidatedSteps } from './invalidation';
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

/** Mismo mapa que usan las reglas: qué paso atiende cada categoría. */
const DOCTOR_STEP: Partial<Record<string, StepKey>> = {
  inference: 'inference',
  globalSignificance: 'inference',
  restrictions: 'inference',
  heteroskedasticity: 'diagnostics',
  multicollinearity: 'diagnostics',
  residuals: 'diagnostics',
  specification: 'diagnostics',
  sample: 'diagnostics',
  stability: 'diagnostics',
  // Series
  stationarity: 'stationarity',
  serialCorrelation: 'identify',
  modelIdentification: 'identify',
  arimaResiduals: 'arimaResiduals',
  forecast: 'forecast',
};

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

  const steps: GuidedStep[] = STEP_DEFINITIONS
    .filter(def => appliesToFlow(def, flow))
    .map(def => {
      const { state, unmet } = baseState(def, ctx);
      return { key: def.key, label: def.label, kind: def.kind, state, unmet, theory: def.theory };
    });

  // Desactualizado: el paso se hizo, pero un cambio río arriba lo dejó viejo.
  // No se re-estima solo; se marca y se espera al estudiante.
  //
  // La invalidación es por paso, no global: con solo el tipo de errores
  // estándar cambiado, lo que el estudiante leyó de signo y magnitud sigue
  // valiendo, y sería falso pedirle que lo revise de nuevo.
  const stale = isStale(ctx)
    ? invalidatedSteps(changedFields(ctx.spec!.signature, ctx.estimatedSignature!))
    : new Set<StepKey>();

  for (const step of steps) {
    if (!stale.has(step.key) || step.state === 'blocked') continue;
    // Un paso invalidado deja de contar como hecho aunque el estudiante lo
    // haya marcado: lo que revisó era de otro modelo.
    step.state = 'review';
    step.reviewReason = 'stale';
  }

  // Un paso cuyo hallazgo de Doctor pide atención pasa a "requiere revisión".
  // El motivo lo distingue del desactualizado: acá el resultado sigue siendo
  // válido, lo que cambió es que el diagnóstico encontró algo.
  const attention = new Set(
    (ctx.doctor?.findings ?? [])
      .filter(f => f.state === 'problem' || f.state === 'review')
      .map(f => DOCTOR_STEP[f.category])
      .filter((k): k is StepKey => k !== undefined)
  );
  for (const step of steps) {
    if (attention.has(step.key) && step.state !== 'blocked' && !step.reviewReason) {
      step.state = 'review';
      step.reviewReason = 'doctor_finding';
    }
  }

  const recommendations = evaluateRules(ctx)
    // G05: lo que Doctor marcó como atendido no vuelve a recomendarse. Se
    // compara por categoría y no por texto, para que no dependa de cómo esté
    // redactado el consejo.
    .filter(rec => {
      if (!rec.sourceCategory || rec.ruleId === 'G05') return true;
      const finding = ctx.doctor?.findings.find(f => f.category === rec.sourceCategory);
      return finding?.state !== 'mitigated';
    });
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
  const IMPACT_RANK: Record<string, number> = { estimation: 4, inference: 3, efficiency: 2, reading: 1 };
  const ordered = [...recommendations].sort((a, b) => {
    const byKind = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (byKind !== 0) return byKind;
    // Entre consejos, manda la consecuencia sobre la fuerza de la evidencia:
    // un p chico con impacto sobre la eficiencia no le gana a uno moderado
    // que compromete la estimación.
    return (IMPACT_RANK[b.impact ?? ''] ?? 0) - (IMPACT_RANK[a.impact ?? ''] ?? 0);
  });

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
