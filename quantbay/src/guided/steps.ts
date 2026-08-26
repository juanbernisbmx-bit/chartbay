// Catálogo de pasos: declarativo a propósito.
//
// Agregar una familia nueva (panel, IV, logit) no debería tocar el
// planificador: alcanza con sumar filas acá, reglas en rules.ts y anclas de
// teoría. Por eso los requisitos son predicados sobre el contexto y no
// condiciones escritas dentro del motor.

import { changedFields } from './invalidation';
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

// ── Series de tiempo ────────────────────────────────────────────────────────
const timeColumns = req('timecols', 'elegir la columna de fecha y la de valor',
  ctx => !!ctx.timeSeries && ctx.timeSeries.dateColumn !== '' && ctx.timeSeries.valueColumn !== '');

const seriesRun = req('seriesrun', 'correr el análisis de la serie',
  ctx => !!ctx.timeSeries?.hasResult);

const arimaEstimated = req('arima', 'estimar un ARIMA',
  ctx => ctx.timeSeries?.arimaOrders !== null && ctx.timeSeries?.arimaOrders !== undefined);

/** Doctor dice que la serie analizada todavía no parece estacionaria. */
function stationarityUnresolved(ctx: AnalysisContext): boolean {
  const finding = ctx.doctor?.findings.find(f => f.category === 'stationarity');
  return finding?.state === 'problem' || finding?.state === 'review';
}

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
    theory: ['teoria-modelo'],
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
    theory: ['teoria-econometria'],
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
    theory: ['teoria-modelo'],
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
    theory: ['teoria-ols'],
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
    theory: ['teoria-ols'],
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
    theory: ['teoria-ols', 'teoria-supuestos'],
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
    theory: ['teoria-inferencia', 'teoria-intervalos'],
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
    theory: ['teoria-supuestos'],
  },
  // ── Series de tiempo ──────────────────────────────────────────────────────
  {
    key: 'timeIndex',
    label: 'Índice temporal',
    kind: 'required',
    appliesTo: ['time_series'],
    requirements: [hasDataset, typeConfirmed],
    isComplete: ctx => timeColumns.test(ctx),
    prompt: {
      title: 'Elegí qué columna es la fecha y cuál el valor',
      body: 'ChartBay detecta la columna de fechas cuando puede, pero conviene confirmarla.',
      why: 'Una serie de tiempo no es una columna más: el orden de las observaciones es información, y todo lo que sigue depende de que las fechas se lean bien.',
    },
    theory: ['teoria-estacionariedad'],
  },
  {
    key: 'timeOrder',
    label: 'Orden y frecuencia',
    kind: 'required',
    appliesTo: ['time_series'],
    requirements: [hasDataset, typeConfirmed, timeColumns],
    isComplete: ctx => seriesRun.test(ctx),
    prompt: {
      title: 'Verificá el orden y la frecuencia',
      body: 'Corré el análisis para ver cuántas observaciones válidas quedan, con qué frecuencia y si hay fechas repetidas o huecos.',
      why: 'Fechas duplicadas o una frecuencia irregular cambian el significado de un rezago, y con eso el de la ACF y el del ADF.',
    },
    theory: ['teoria-estacionariedad'],
  },
  {
    key: 'plotSeries',
    label: 'Gráfico de la serie',
    kind: 'recommended',
    appliesTo: ['time_series'],
    requirements: [seriesRun],
    isComplete: ctx => ctx.session.acknowledged.includes('plotSeries'),
    prompt: {
      title: 'Mirá la serie antes de testear',
      body: '¿Hay tendencia? ¿La media se mueve? ¿La varianza crece con el nivel? ¿Se ve un quiebre?',
      why: 'El gráfico contesta en dos segundos lo que después vas a contrastar con un test, y muestra cosas que ningún test reporta: quiebres, estacionalidad, valores imposibles.',
    },
    theory: ['teoria-estacionariedad'],
  },
  {
    key: 'stationarity',
    label: 'Estacionariedad',
    kind: 'required',
    appliesTo: ['time_series'],
    requirements: [seriesRun],
    isComplete: ctx => seriesRun.test(ctx) && !stationarityUnresolved(ctx),
    prompt: {
      title: 'Revisá si la serie es estacionaria',
      body: 'El ADF contrasta la presencia de una raíz unitaria en la serie que estás analizando.',
      why: 'Modelar en niveles una serie no estacionaria produce regresiones espurias: R² altos y estadísticos grandes que no reflejan ninguna relación.',
    },
    theory: ['teoria-adf', 'teoria-estacionariedad'],
  },
  {
    key: 'transform',
    label: 'Transformación',
    kind: 'conditional',
    appliesTo: ['time_series'],
    requirements: [seriesRun],
    // Se completa cuando se dejó de analizar la serie original: ahí el lazo
    // vuelve a estacionariedad para re-testear sobre la serie nueva.
    isComplete: ctx => (ctx.timeSeries?.transformation ?? 'original') !== 'original',
    prompt: {
      title: 'Probá una transformación y volvé a testear',
      body: 'Diferenciar o tomar retornos logarítmicos, y correr el ADF de nuevo sobre la serie transformada.',
      why: 'El test se aplica a la serie que vas a modelar, no a la original. Si transformás, la pregunta sobre estacionariedad se vuelve a abrir.',
    },
    theory: ['teoria-estacionariedad', 'teoria-adf'],
  },
  {
    key: 'identify',
    label: 'Identificación',
    kind: 'recommended',
    appliesTo: ['time_series'],
    requirements: [seriesRun],
    isComplete: ctx => ctx.session.acknowledged.includes('identify'),
    prompt: {
      title: 'Leé la ACF y la PACF',
      body: 'Un corte en la PACF sugiere una parte autorregresiva; un corte en la ACF, una de medias móviles; un decaimiento lento, que falta diferenciar.',
      why: 'Los órdenes de un ARIMA no se adivinan ni se eligen por prueba y error: se leen del patrón de autocorrelación.',
    },
    theory: ['teoria-acf-pacf'],
  },
  {
    key: 'arima',
    label: 'ARIMA',
    kind: 'conditional',
    appliesTo: ['time_series'],
    requirements: [seriesRun],
    isComplete: ctx => arimaEstimated.test(ctx),
    prompt: {
      title: 'Estimá un ARIMA con los órdenes que sugiere el patrón',
      body: 'Disponible en el motor Pro, que corre statsmodels en el navegador.',
      why: 'El ARIMA resume la dinámica de la serie en pocos parámetros; sin él no hay pronóstico ni residuos que diagnosticar.',
    },
    theory: ['teoria-arima'],
  },
  {
    key: 'arimaResiduals',
    label: 'Residuos del ARIMA',
    kind: 'required',
    appliesTo: ['time_series'],
    requirements: [seriesRun, arimaEstimated],
    isComplete: ctx => ctx.session.acknowledged.includes('arimaResiduals'),
    prompt: {
      title: 'Revisá los residuos del ARIMA',
      body: 'Ljung-Box sobre los residuos contesta si quedó estructura temporal sin capturar.',
      why: 'Acá un Ljung-Box significativo sí es un problema, al revés que sobre la serie original: significa que los órdenes elegidos no describen toda la dinámica.',
    },
    theory: ['teoria-arima', 'teoria-acf-pacf'],
  },
  {
    key: 'forecast',
    label: 'Pronóstico',
    kind: 'optional',
    appliesTo: ['time_series'],
    requirements: [seriesRun, arimaEstimated],
    isComplete: ctx => ctx.session.acknowledged.includes('forecast'),
    prompt: {
      title: 'Proyectá la serie si te interesa',
      body: 'El horizonte y los intervalos salen del modelo estimado.',
      why: 'Un pronóstico hereda todos los supuestos del modelo: si los residuos no están limpios, los intervalos van a estar mal calibrados.',
    },
    theory: ['teoria-arima'],
  },
  {
    // Opcional a propósito: contrastar una sola especificación contra nada no
    // enseña nada, y marcarlo "pendiente" empujaría a todo el mundo a guardar
    // modelos porque el riel lo pide. Se vuelve relevante por regla, cuando
    // hay algo real que contrastar.
    key: 'compare',
    label: 'Comparar especificaciones',
    kind: 'optional',
    appliesTo: ['cross_section', 'time_series'],
    requirements: [estimated],
    // Hace falta evidencia, no solo haber tocado un botón: el click de la guía
    // lleva el foco al panel pero no guarda nada. Sin las dos condiciones, el
    // paso quedaba completo sin que existiera ninguna comparación.
    isComplete: ctx => (ctx.comparison?.saved ?? 0) >= 2
      && ctx.session.acknowledged.includes('compare'),
    prompt: {
      title: 'Contrastá esta especificación con otra',
      body: 'Guardá la estimación actual, cambiá algo del modelo, estimá de nuevo y mirá las dos al lado.',
      why: 'Un resultado que solo aparece bajo una especificación no es un hallazgo: es una propiedad de esa especificación. Ver qué se mueve y qué se sostiene al cambiar el modelo es lo que separa un resultado robusto de uno que depende de cómo se lo miró.',
    },
    theory: ['teoria-modelo'],
  },
  {
    key: 'conclude',
    label: 'Revisión final',
    kind: 'recommended',
    appliesTo: ['cross_section', 'time_series'],
    requirements: [],
    isComplete: ctx => ctx.session.acknowledged.includes('conclude'),
    prompt: {
      title: 'Repasá el recorrido antes de concluir',
      body: 'Mirá qué decisiones tomaste y qué quedó sin revisar.',
      why: 'Un análisis se defiende explicando las decisiones que lo produjeron, no solo mostrando el resultado final.',
    },
    theory: [],
  },
];

/**
 * Los resultados en pantalla corresponden a una especificación anterior.
 *
 * Delega en changedFields en vez de comparar campo por campo acá. Tenerlo
 * duplicado ya costó un error: al sumar la transformación de la serie a la
 * firma, G02 la detectaba pero esta función no, así que avisaba del
 * desactualizado y al mismo tiempo dejaba el paso en verde.
 */
export function isStale(ctx: AnalysisContext): boolean {
  if (!ctx.hasResult || !ctx.spec || !ctx.estimatedSignature) return false;
  return changedFields(ctx.spec.signature, ctx.estimatedSignature).length > 0;
}

export function stepDefinition(key: StepKey): StepDefinition {
  const found = STEP_DEFINITIONS.find(s => s.key === key);
  if (!found) throw new Error(`Paso desconocido: ${key}`);
  return found;
}
