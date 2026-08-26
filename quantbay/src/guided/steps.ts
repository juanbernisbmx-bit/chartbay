// Catálogo de pasos: declarativo a propósito.
//
// Agregar una familia nueva (panel, IV, logit) no debería tocar el
// planificador: alcanza con sumar filas acá, reglas en rules.ts y anclas de
// teoría. Por eso los requisitos son predicados sobre el contexto y no
// condiciones escritas dentro del motor.

import type { AnalysisContext, Requirement, StepKey, StepKind } from './types';

export interface StepDefinition {
  key: StepKey;
  label: string;
  kind: StepKind;
  /** Flujos en los que el paso tiene sentido. */
  appliesTo: Array<'cross_section' | 'time_series'>;
  requirements: Requirement[];
  /** Cuándo se considera hecho. */
  isComplete: (ctx: AnalysisContext) => boolean;
  /**
   * Texto que se muestra cuando este paso es el próximo sugerido y ninguna
   * regla de mayor prioridad tomó el panel.
   */
  prompt: { title: string; body: string; why: string };
  theory: string[];
}

const req = (id: string, describe: string, test: (ctx: AnalysisContext) => boolean): Requirement =>
  ({ id, describe, test });

const hasDataset = req('dataset', 'cargar un CSV con al menos una fila y una columna',
  ctx => ctx.dataset !== null && ctx.dataset.rows > 0 && ctx.dataset.columns > 0);

const typeConfirmed = req('type', 'confirmar qué tipo de análisis vas a hacer',
  ctx => ctx.session.confirmedType !== null);

const varsChosen = req('vars', 'elegir una variable Y y al menos una X distinta de Y',
  ctx => !!ctx.spec && ctx.spec.yName !== '' && ctx.spec.xNames.length > 0
      && !ctx.spec.xNames.includes(ctx.spec.yName));

const noBlockingWarnings = req('clean', 'decidir qué hacer con los datos faltantes de las columnas del modelo',
  ctx => !(ctx.dataset?.warnings ?? []).some(w => w.blocking));

const estimated = req('estimated', 'estimar el modelo',
  ctx => ctx.hasResult);

export const STEP_DEFINITIONS: StepDefinition[] = [
  {
    key: 'load',
    label: 'Datos',
    kind: 'required',
    appliesTo: ['cross_section', 'time_series'],
    requirements: [],
    isComplete: ctx => hasDataset.test(ctx),
    prompt: {
      title: 'Cargá un dataset para empezar',
      body: 'Subí un CSV con encabezados en la primera fila, o probá uno de los ejemplos.',
      why: 'Todo el análisis parte de los datos: sin ellos no hay nada que estimar ni diagnosticar.',
    },
    theory: [],
  },
  {
    key: 'profile',
    label: 'Exploración',
    kind: 'required',
    appliesTo: ['cross_section', 'time_series'],
    requirements: [hasDataset],
    isComplete: ctx => hasDataset.test(ctx),
    prompt: {
      title: 'Mirá qué trajo el archivo',
      body: 'Revisá cuántas observaciones hay, qué tipo tiene cada columna y si aparecieron faltantes o valores atípicos.',
      why: 'Las decisiones que siguen —qué modelo corresponde, qué variables se pueden usar— dependen de lo que efectivamente contiene el dataset.',
    },
    theory: ['modelo y datos'],
  },
  {
    key: 'analysisType',
    label: 'Tipo de análisis',
    kind: 'required',
    appliesTo: ['cross_section', 'time_series'],
    requirements: [hasDataset],
    isComplete: ctx => typeConfirmed.test(ctx),
    prompt: {
      title: 'Confirmá qué tipo de análisis vas a hacer',
      body: 'ChartBay mira las columnas y sugiere uno, pero la decisión es tuya.',
      why: 'Corte transversal y series de tiempo no comparten diagnósticos: una serie necesita estacionariedad y autocorrelación, una regresión de corte transversal no.',
    },
    theory: ['pregunta econometrica'],
  },
  {
    key: 'variables',
    label: 'Variables',
    kind: 'required',
    appliesTo: ['cross_section'],
    requirements: [hasDataset, typeConfirmed],
    isComplete: ctx => varsChosen.test(ctx),
    prompt: {
      title: 'Elegí qué querés explicar y con qué',
      body: 'La Y es lo que querés explicar; las X, lo que usás para explicarlo. ChartBay marca qué columnas son compatibles, pero no decide cuál va de qué lado.',
      why: 'La dirección del modelo es una decisión teórica: los datos no dicen qué variable explica a cuál.',
    },
    theory: ['modelo y datos'],
  },
  {
    key: 'specification',
    label: 'Especificación',
    kind: 'required',
    appliesTo: ['cross_section'],
    requirements: [hasDataset, typeConfirmed, varsChosen],
    isComplete: ctx => varsChosen.test(ctx),
    prompt: {
      title: 'Revisá cómo quedó especificado el modelo',
      body: 'Forma funcional, intercepto, categóricas y su categoría base. De esto depende cómo se leen los coeficientes.',
      why: 'La misma estimación se interpreta distinto según la forma funcional: en nivel-nivel un coeficiente son unidades, en log-nivel es una semi-elasticidad.',
    },
    theory: ['OLS'],
  },
  {
    key: 'estimate',
    label: 'Estimación',
    kind: 'required',
    appliesTo: ['cross_section'],
    requirements: [hasDataset, typeConfirmed, varsChosen, noBlockingWarnings],
    isComplete: ctx => ctx.hasResult && !isStale(ctx),
    prompt: {
      title: 'Estimá el modelo',
      body: 'Con la especificación lista, corré la regresión.',
      why: 'Los diagnósticos se calculan sobre los residuos del modelo estimado: sin estimación no hay nada que diagnosticar.',
    },
    theory: ['OLS'],
  },
  {
    key: 'readCoefficients',
    label: 'Coeficientes',
    kind: 'recommended',
    appliesTo: ['cross_section'],
    requirements: [estimated],
    isComplete: ctx => ctx.session.acknowledged.includes('readCoefficients'),
    prompt: {
      title: 'Leé los coeficientes antes de mirar los tests',
      body: 'Fijate en el signo y en la magnitud: ¿van en la dirección que espera la teoría? ¿El tamaño es plausible para el contexto?',
      why: 'Un coeficiente con el signo equivocado o una magnitud imposible pasa igual todos los tests estadísticos. Mirar la significancia primero enseña a validar modelos que no tienen sentido económico.',
    },
    theory: ['OLS', 'supuestos y sesgo'],
  },
  {
    key: 'inference',
    label: 'Inferencia',
    kind: 'recommended',
    appliesTo: ['cross_section'],
    requirements: [estimated],
    isComplete: ctx => ctx.session.acknowledged.includes('inference'),
    prompt: {
      title: 'Revisá la inferencia',
      body: 'Errores estándar, estadísticos t, p-valores e intervalos de confianza.',
      why: 'La significancia depende de que la fórmula de los errores estándar sea válida, y eso depende de supuestos que conviene revisar antes de concluir.',
    },
    theory: ['t y p-value', 'IC y F'],
  },
  {
    key: 'diagnostics',
    label: 'Diagnósticos',
    kind: 'recommended',
    appliesTo: ['cross_section'],
    requirements: [estimated],
    isComplete: ctx => ctx.session.acknowledged.includes('diagnostics'),
    prompt: {
      title: 'Revisá los diagnósticos del modelo',
      body: 'Residuos, multicolinealidad y heterocedasticidad. Model Doctor los ordena por consecuencia.',
      why: 'Los diagnósticos no dicen si el modelo es bueno: dicen qué parte de los resultados podés leer con confianza y cuál no.',
    },
    theory: ['supuestos y sesgo'],
  },
  {
    key: 'conclude',
    label: 'Revisión final',
    kind: 'recommended',
    appliesTo: ['cross_section'],
    requirements: [estimated],
    isComplete: ctx => ctx.session.acknowledged.includes('conclude'),
    prompt: {
      title: 'Repasá el recorrido antes de concluir',
      body: 'Mirá qué decisiones tomaste y qué quedó sin revisar.',
      why: 'Un análisis se defiende explicando las decisiones que lo produjeron, no solo mostrando el resultado final.',
    },
    theory: [],
  },
];

/** Los resultados en pantalla corresponden a una especificación anterior. */
export function isStale(ctx: AnalysisContext): boolean {
  if (!ctx.hasResult || !ctx.spec || !ctx.estimatedSignature) return false;
  return !sameSignature(ctx.spec.signature, ctx.estimatedSignature);
}

export function sameSignature(
  a: AnalysisContext['estimatedSignature'],
  b: AnalysisContext['estimatedSignature']
): boolean {
  if (a === null || b === null) return a === b;
  return a.dataset === b.dataset
    && a.yName === b.yName
    && a.xNames === b.xNames
    && a.form === b.form
    && a.seType === b.seType
    && a.dropIncomplete === b.dropIncomplete
    && a.restriction === b.restriction;
}

export function stepDefinition(key: StepKey): StepDefinition {
  const found = STEP_DEFINITIONS.find(s => s.key === key);
  if (!found) throw new Error(`Paso desconocido: ${key}`);
  return found;
}
