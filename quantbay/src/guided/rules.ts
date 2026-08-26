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
import { changedFields, describeChanges, onlyInferenceChanged } from './invalidation';
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
      return changedFields(ctx.spec.signature, ctx.estimatedSignature).length > 0;
    },
    build: ctx => {
      const changes = changedFields(ctx.spec!.signature, ctx.estimatedSignature!);
      const what = describeChanges(changes);
      const onlySe = onlyInferenceChanged(changes);
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

/**
 * Categorías con regla propia. G04 no las toca.
 *
 * Una regla especializada sabe cosas que la genérica no puede saber: G07
 * conoce el lazo de transformar y volver a testear, y el costo de diferenciar.
 * Sin esta exclusión, G04 le ganaba por impacto y el consejo terminaba siendo
 * el texto genérico de Doctor, perdiendo todo lo específico del dominio.
 */
const SPECIALISED: DoctorCategoryKey[] = ['stationarity', 'arimaResiduals', 'forecast'];

function genericFindings(ctx: AnalysisContext) {
  return findingsOf(ctx).filter(f => f.state === 'problem' && !SPECIALISED.includes(f.category));
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
    when: ctx => genericFindings(ctx).length > 0,
    build: ctx => {
      // El de mayor consecuencia manda; el orden lo define Doctor, no la guía.
      const rank: Record<string, number> = { estimation: 4, inference: 3, efficiency: 2, reading: 1 };
      const worst = [...genericFindings(ctx)]
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

// ── Etapa 5 · reglas del flujo temporal ─────────────────────────────────────

/** Estado que Doctor le puso a una categoría, si la evaluó. */
function doctorState(ctx: AnalysisContext, category: DoctorCategoryKey) {
  return ctx.doctor?.findings.find(f => f.category === category)?.state;
}

GUIDED_RULES.push(
  {
    // G07 — el lazo de estacionariedad sigue abierto: el ADF no rechaza y la
    // serie que se está mirando es todavía la original.
    id: 'G07',
    kind: 'advisory',
    targetStep: 'transform',
    priority: 85,
    when: ctx => {
      if (!ctx.timeSeries?.hasResult) return false;
      if (ctx.timeSeries.transformation !== 'original') return false;
      const state = doctorState(ctx, 'stationarity');
      return state === 'problem' || state === 'review';
    },
    build: () => rec({ id: 'G07', kind: 'advisory', targetStep: 'transform' }, {
      title: 'La serie todavía no parece estacionaria',
      body: 'Podés diferenciar o tomar retornos logarítmicos, y volver a correr el ADF sobre la serie transformada.',
      why: 'Modelar en niveles una serie con raíz unitaria produce regresiones espurias. Ojo con el costo: diferenciar borra la relación de largo plazo, así que si lo que te interesa es cómo se mueven juntas dos series con tendencia común, el camino es cointegración y no diferenciar. Y el ADF tiene poca potencia: no rechazar no prueba que haya raíz unitaria.',
      actions: [{ label: 'Elegir una transformación', focus: 'qb-ts-transform' }],
      theory: ['estacionariedad', 'ADF'],
    }),
  },
  {
    // G08 — hay pronóstico sobre una base dudosa. Acompaña, no bloquea:
    // frenar acá sería paternalista y esconder la salvedad, negligente.
    id: 'G08',
    kind: 'advisory',
    targetStep: 'forecast',
    priority: 40,
    when: ctx => {
      if (!ctx.timeSeries?.arimaOrders) return false;
      const residuals = doctorState(ctx, 'arimaResiduals');
      const stationarity = doctorState(ctx, 'stationarity');
      return residuals === 'problem' || residuals === 'review'
          || stationarity === 'problem' || stationarity === 'review';
    },
    build: ctx => {
      const residuals = doctorState(ctx, 'arimaResiduals');
      const motivo = residuals === 'problem' || residuals === 'review'
        ? 'los residuos del ARIMA todavía muestran estructura sin capturar'
        : 'la estacionariedad de la serie quedó en duda';
      return rec({ id: 'G08', kind: 'advisory', targetStep: 'forecast' }, {
        title: 'El pronóstico se apoya en una base que conviene mirar',
        body: `Podés proyectar igual, pero ${motivo}, así que los intervalos van a estar mal calibrados.`,
        why: 'Un pronóstico hereda todos los supuestos del modelo. La proyección central puede seguir siendo razonable; lo que deja de ser confiable es la banda de incertidumbre, que es justamente lo que un pronóstico aporta sobre una extrapolación a ojo.',
        actions: [{ label: 'Revisar los residuos', focus: 'qb-pro-ts-content' }],
        theory: ['ARIMA'],
      });
    },
  }
);

// ── Etapa 8 · contraste de especificaciones ─────────────────────────────────
//
// Misma frontera que con Model Doctor: acá no se decide si dos modelos son
// comparables ni se redactan los motivos. Eso lo dictamina assessComparability
// y llega hecho en ctx.comparison. La guía elige el momento y traduce a acción.
//
// Y lo que NUNCA se hace acá: elegir un ganador. Ninguna de estas reglas dice
// que un modelo sea mejor que otro. Un R² más alto no es evidencia de nada por
// sí solo, y una guía que coronara modelos enseñaría exactamente el hábito que
// el panel de comparación existe para desarmar.

GUIDED_RULES.push(
  {
    // G11 — probó varias especificaciones y no guardó ninguna, así que las
    // anteriores no existen en ningún lado. Es el hábito más caro del
    // aprendizaje: estimar, no gustar el resultado, cambiar algo, estimar de
    // nuevo, y quedarse con la última sin haber visto nunca las dos juntas.
    id: 'G11',
    kind: 'advisory',
    targetStep: 'compare',
    priority: 35,
    when: ctx => ctx.session.estimatedSpecs.length >= 2
      && (ctx.comparison?.saved ?? 0) < 2
      && ctx.hasResult,
    build: ctx => {
      const probadas = ctx.session.estimatedSpecs.length;
      const guardadas = ctx.comparison?.saved ?? 0;
      return rec({ id: 'G11', kind: 'advisory', targetStep: 'compare' }, {
        title: `Probaste ${probadas} especificaciones y solo queda la última`,
        body: guardadas === 0
          ? 'Cada corrida reemplaza a la anterior en pantalla. Guardá esta estimación para poder contrastarla con la próxima.'
          : 'Tenés una guardada. Guardá también la que está en pantalla para verlas al lado.',
        why: 'Cambiar el modelo hasta que el resultado guste, y reportar solo esa corrida, es el mecanismo por el que aparecen hallazgos que no se replican. Lo que vuelve honesto al ejercicio es mostrar qué se sostiene y qué se mueve entre especificaciones — y para eso hay que conservarlas.',
        actions: [{ label: 'Guardar esta estimación', focus: 'qb-comparison-save' }],
        theory: ['modelo y datos'],
      });
    },
  },
  {
    // G12 — hay dos o más guardadas y el motor dice que la comparación no es
    // directa. Se muestra antes que G13: si los modelos no están en la misma
    // escala, leer un cambio de significancia entre ellos no significa nada.
    id: 'G12',
    kind: 'advisory',
    targetStep: 'compare',
    priority: 50,
    when: ctx => (ctx.comparison?.saved ?? 0) >= 2
      && ctx.comparison?.level !== null
      && ctx.comparison?.level !== 'direct',
    build: ctx => {
      const bloqueado = ctx.comparison!.level === 'incompatible';
      // Los motivos llegan redactados por el motor y se muestran tal cual.
      const motivos = bloqueado ? ctx.comparison!.blocking : ctx.comparison!.cautions;
      return rec({ id: 'G12', kind: 'advisory', targetStep: 'compare' }, {
        title: bloqueado
          ? 'Los modelos que guardaste no se pueden comparar de frente'
          : 'La comparación se puede leer, pero con cautela',
        body: motivos.join(' '),
        why: bloqueado
          ? 'Poner dos números uno al lado del otro no los vuelve comparables. Si la variable dependiente o su escala cambian, el R² y los coeficientes de un modelo no significan lo mismo que los del otro, y la tabla invitaría a una conclusión que los datos no soportan.'
          : 'La comparación sigue siendo informativa, pero no todas las filas de la tabla se leen igual: el panel marca cuáles quedan fuera de comparación directa y por qué.',
        actions: [{ label: 'Ver la comparación', focus: 'qb-model-comparison' }],
        theory: ['modelo y datos'],
      });
    },
  },
  {
    // G13 — un coeficiente cambia de significancia según la especificación.
    // Es el momento pedagógico del panel: no es un menú para quedarse con la
    // corrida que da significativo.
    id: 'G13',
    kind: 'advisory',
    targetStep: 'compare',
    priority: 45,
    when: ctx => (ctx.comparison?.significanceFlips.length ?? 0) > 0,
    build: ctx => {
      const cuales = ctx.comparison!.significanceFlips;
      const lista = cuales.slice(0, 3).join(', ');
      return rec({ id: 'G13', kind: 'advisory', targetStep: 'compare' }, {
        title: cuales.length === 1
          ? 'Un coeficiente cambia de significancia entre especificaciones'
          : 'Hay coeficientes que cambian de significancia entre especificaciones',
        body: `Según qué modelo mires, ${lista} cruza${cuales.length === 1 ? '' : 'n'} el umbral de 5%.`,
        why: 'Que un resultado aparezca y desaparezca al cambiar el modelo es información sobre lo frágil que es la conclusión, y hay que reportarlo. Quedarse con la especificación que da significativo, sin decir que las otras no, es p-hacking: el p-valor deja de significar lo que dice significar cuando se elige la corrida después de ver el resultado.',
        actions: [{ label: 'Ver qué cambió', focus: 'qb-comparison-filter' }],
        theory: ['t y p-value'],
      });
    },
  }
);
