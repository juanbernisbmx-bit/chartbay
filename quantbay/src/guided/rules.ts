// Reglas de la etapa 2: G01, G02, G03 y G10.
//
// Las reglas son datos, no ramas dentro del planificador: cada una declara
// cuándo aplica y qué recomienda. Se evalúan todas y la prioridad decide qué
// se muestra, así se pueden testear de a una y agregar sin tocar el motor.
//
// Regla de frontera: acá NO se evalúa evidencia estadística. Ningún umbral
// (p, VIF, α) se escribe en este archivo. Los estados vienen de Model Doctor
// y las conclusiones, de la capa de interpretación. Guiada solo traduce
// estados en acciones y las ordena.

import type { DoctorCategoryKey, DoctorFinding } from '../modelDoctor/types';
import type { AnalysisContext, Recommendation, RecommendationKind, StepKey } from './types';

export interface GuidedRule {
  id: string;
  kind: RecommendationKind;
  targetStep: StepKey;
  /** Desempate estable; mayor gana. */
  priority: number;
  when: (ctx: AnalysisContext) => boolean;
  build: (ctx: AnalysisContext) => Recommendation;
}

const rec = (
  rule: Pick<GuidedRule, 'id' | 'kind' | 'targetStep'>,
  parts: Pick<Recommendation, 'title' | 'body' | 'why' | 'actions' | 'theory'> & { dismissible?: boolean }
): Recommendation => ({
  id: rule.id,
  ruleId: rule.id,
  kind: rule.kind,
  targetStep: rule.targetStep,
  title: parts.title,
  body: parts.body,
  why: parts.why,
  actions: parts.actions,
  theory: parts.theory,
  dismissible: parts.dismissible ?? rule.kind !== 'blocking',
});

/** Columnas del modelo que tienen faltantes, para nombrarlas en el mensaje. */
function missingModelColumns(ctx: AnalysisContext): string[] {
  if (!ctx.dataset || !ctx.spec) return [];
  const used = new Set([ctx.spec.yName, ...ctx.spec.xNames]);
  return Object.entries(ctx.dataset.missingByColumn)
    .filter(([col, count]) => count > 0 && used.has(col))
    .map(([col]) => col);
}

export const GUIDED_RULES: GuidedRule[] = [
  {
    // G01 — hay huecos en las columnas del modelo y no se declaró qué hacer.
    id: 'G01',
    kind: 'blocking',
    targetStep: 'estimate',
    priority: 100,
    when: ctx => !ctx.spec?.dropIncomplete && missingModelColumns(ctx).length > 0,
    build: ctx => {
      const cols = missingModelColumns(ctx);
      const detail = cols
        .map(c => `${c} (${ctx.dataset?.missingByColumn[c] ?? 0})`)
        .join(', ');
      return rec({ id: 'G01', kind: 'blocking', targetStep: 'estimate' }, {
        title: 'Antes de continuar: hay valores faltantes',
        body: `Faltan datos en ${detail}. Podés excluir esas filas del modelo, o volver al Limpiador si preferís otra política.`,
        why: 'Un hueco no es un cero. Mientras no decidas qué hacer con esas filas, no está definido sobre qué muestra se estimaría el modelo — y esa decisión cambia los coeficientes.',
        actions: [
          { label: 'Excluir las filas incompletas', focus: 'qb-drop-incomplete' },
          { label: 'Ir al Limpiador', focus: 'qb-nav-limpiador' },
        ],
        theory: ['modelo y datos'],
      });
    },
  },
  {
    // G02 — lo que está en pantalla es de otra especificación.
    id: 'G02',
    kind: 'blocking',
    targetStep: 'estimate',
    priority: 95,
    when: ctx => {
      if (!ctx.hasResult || !ctx.spec || !ctx.estimatedSignature) return false;
      const a = ctx.spec.signature, b = ctx.estimatedSignature;
      return a.dataset !== b.dataset || a.yName !== b.yName || a.xNames !== b.xNames
          || a.form !== b.form || a.seType !== b.seType
          || a.dropIncomplete !== b.dropIncomplete || a.restriction !== b.restriction;
    },
    build: ctx => {
      const a = ctx.spec!.signature, b = ctx.estimatedSignature!;
      const changed: string[] = [];
      if (a.dataset !== b.dataset) changed.push('el dataset');
      if (a.yName !== b.yName) changed.push('la variable Y');
      if (a.xNames !== b.xNames) changed.push('las variables X');
      if (a.form !== b.form) changed.push('la forma funcional');
      if (a.seType !== b.seType) changed.push('el tipo de errores estándar');
      if (a.dropIncomplete !== b.dropIncomplete) changed.push('la política de faltantes');
      if (a.restriction !== b.restriction) changed.push('la restricción');
      const what = changed.length === 1
        ? changed[0]
        : `${changed.slice(0, -1).join(', ')} y ${changed[changed.length - 1]}`;
      const onlySe = changed.length === 1 && a.seType !== b.seType;
      return rec({ id: 'G02', kind: 'blocking', targetStep: 'estimate' }, {
        title: 'Los resultados en pantalla quedaron viejos',
        body: `Cambiaste ${what}. Lo que se está mostrando corresponde a la especificación anterior.`,
        why: onlySe
          ? 'Cambiar el tipo de errores estándar no mueve los coeficientes, pero sí los errores estándar, los t, los p-valores y los intervalos. Todo lo que dependa de inferencia hay que recalcularlo.'
          : 'Los diagnósticos se calculan sobre los residuos de una estimación concreta. Leerlos junto a otra especificación mezcla dos modelos distintos sin que se note.',
        actions: [{ label: 'Volver a estimar', focus: 'qb-run' }],
        theory: [],
      });
    },
  },
  {
    // G03 — signo y magnitud antes que significancia.
    id: 'G03',
    kind: 'advisory',
    targetStep: 'readCoefficients',
    priority: 60,
    when: ctx => ctx.hasResult
      && !ctx.session.acknowledged.includes('readCoefficients'),
    build: () => rec({ id: 'G03', kind: 'advisory', targetStep: 'readCoefficients' }, {
      title: 'Leé los coeficientes antes de mirar los tests',
      body: 'Fijate primero en el signo y en la magnitud de cada coeficiente: ¿apuntan en la dirección que espera la teoría? ¿El tamaño es plausible?',
      why: 'Un coeficiente con el signo equivocado pasa igual todos los tests estadísticos. Empezar por el p-valor enseña a validar modelos que no tienen sentido económico.',
      actions: [{ label: 'Ya los revisé', focus: 'qb-coef-body' }],
      theory: ['OLS', 'supuestos y sesgo'],
    }),
  },
  {
    // G10 — cierre. No dice que el modelo esté bien: dice que no quedan pasos.
    id: 'G10',
    kind: 'informational',
    targetStep: 'conclude',
    priority: 10,
    when: ctx => ctx.hasResult
      && ctx.session.acknowledged.includes('readCoefficients')
      && ctx.session.acknowledged.includes('inference')
      && ctx.session.acknowledged.includes('diagnostics')
      && !ctx.session.acknowledged.includes('conclude'),
    build: () => rec({ id: 'G10', kind: 'informational', targetStep: 'conclude' }, {
      title: 'No quedan revisiones pendientes en el recorrido',
      body: 'Repasá las decisiones que tomaste antes de dar el análisis por cerrado.',
      why: 'Que no queden pasos pendientes no significa que el modelo sea correcto: significa que revisaste los ejes que ChartBay puede evaluar. Lo que queda afuera —causalidad, variables omitidas, si la muestra representa a la población— no lo puede contestar ningún test.',
      actions: [{ label: 'Ver el recorrido', focus: 'qb-guided' }],
      theory: [],
    }),
  },
];

// ── Etapa 3 · reglas que consumen Model Doctor ──────────────────────────────
//
// Acá no se evalúa nada: los estados, la consecuencia y los textos vienen del
// informe. La guía agrega el paso al que apunta y el control con el que se
// atiende. Los textos de Doctor NO se reescriben.

/** A qué paso del recorrido le corresponde cada categoría del informe. */
const CATEGORY_STEP: Partial<Record<DoctorCategoryKey, StepKey>> = {
  inference: 'inference',
  globalSignificance: 'inference',
  restrictions: 'inference',
  heteroskedasticity: 'diagnostics',
  multicollinearity: 'diagnostics',
  residuals: 'diagnostics',
  specification: 'diagnostics',
  sample: 'diagnostics',
  stability: 'diagnostics',
};

function findingsOf(ctx: AnalysisContext) {
  return ctx.doctor?.findings ?? [];
}

/** Traduce un hallazgo en recomendación, sin tocar los textos de Doctor. */
function fromFinding(
  ruleId: string,
  kind: RecommendationKind,
  finding: DoctorFinding
): Recommendation {
  const step = CATEGORY_STEP[finding.category] ?? 'diagnostics';
  return {
    id: `${ruleId}:${finding.category}`,
    ruleId,
    kind,
    targetStep: step,
    sourceCategory: finding.category,
    impact: finding.impact,
    title: finding.headlineText,
    body: finding.detail.conclusion,
    why: finding.detail.whyItMatters,
    actions: finding.detail.whatToCheck.slice(0, 2).map(check => ({ label: check.text })),
    theory: finding.detail.theory.map(link => link.id),
    dismissible: kind !== 'blocking',
  };
}

GUIDED_RULES.push(
  {
    // G04 — hallazgo con consecuencia sobre la inferencia todavía sin atender.
    id: 'G04',
    kind: 'advisory',
    targetStep: 'inference',
    priority: 80,
    when: ctx => findingsOf(ctx).some(f => f.state === 'problem'),
    build: ctx => {
      // El de mayor consecuencia manda; el orden lo define Doctor, no la guía.
      const rank: Record<string, number> = { estimation: 4, inference: 3, efficiency: 2, reading: 1 };
      const worst = findingsOf(ctx)
        .filter(f => f.state === 'problem')
        .sort((a, b) => (rank[b.impact] ?? 0) - (rank[a.impact] ?? 0))[0];
      return fromFinding('G04', 'advisory', worst);
    },
  },
  {
    // G05 — lo que el estudiante ya atendió no se vuelve a recomendar.
    // Informativa: deja dicho que la consecuencia está cubierta y qué queda
    // afuera de esa cobertura. La supresión real la hace el planificador.
    id: 'G05',
    kind: 'informational',
    targetStep: 'diagnostics',
    priority: 20,
    when: ctx => findingsOf(ctx).some(f => f.state === 'mitigated'),
    build: ctx => {
      const mitigated = findingsOf(ctx).find(f => f.state === 'mitigated')!;
      return fromFinding('G05', 'informational', mitigated);
    },
  },
  {
    // G06 — un diagnóstico que no se pudo evaluar. Se recomienda conseguirlo,
    // citando el motivo que dio Doctor. Lo que es 'not_applicable' no genera
    // nada: es la regla que evita enseñar que hay que correr todos los tests.
    id: 'G06',
    kind: 'advisory',
    targetStep: 'diagnostics',
    priority: 30,
    when: ctx => findingsOf(ctx).some(f => f.state === 'insufficient'),
    build: ctx => {
      const missing = findingsOf(ctx).find(f => f.state === 'insufficient')!;
      const base = fromFinding('G06', 'advisory', missing);
      return {
        ...base,
        // Sin impacto: el `impact` de un hallazgo describe la consecuencia de
        // un problema DETECTADO. Un diagnóstico que no se pudo correr no
        // detectó nada, así que heredarlo lo hacía competir de igual a igual
        // con problemas reales — y ganarles cuando la categoría faltante era
        // de estimación. Conseguir un diagnóstico nunca es más urgente que
        // atender uno que ya encontró algo.
        impact: undefined,
        title: `Falta un diagnóstico: ${missing.headlineText}`,
        body: missing.detail.conclusion,
      };
    },
  }
);
