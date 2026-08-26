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
