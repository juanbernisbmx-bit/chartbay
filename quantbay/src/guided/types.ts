// Econometría Guiada — tipos del recorrido.
//
// Ojo con el vocabulario: estos estados describen PROGRESO de la sesión, no
// evidencia estadística. Model Doctor tiene su propio juego de estados (ok,
// problem, mitigated, insufficient…) que habla de los datos. Un paso puede
// estar 'done' y contener un hallazgo 'problem': son ejes distintos y
// mezclarlos es el error más fácil de cometer acá.

import type { ParsedCSV } from '../csvParser';
import type { FunctionalForm } from '../functionalForms';
import type { DoctorCategoryKey, DoctorImpact, DoctorReport } from '../modelDoctor/types';
import type { ComparisonLevel } from '../modelComparison/types';

export type AnalysisType = 'cross_section' | 'time_series' | 'descriptive';
export type GuidedMode = 'guided' | 'free';

export type StepKey =
  // Comunes a los dos flujos
  | 'load'
  | 'profile'
  | 'analysisType'
  | 'conclude'
  // Corte transversal
  | 'variables'
  | 'specification'
  | 'estimate'
  | 'readCoefficients'
  | 'inference'
  | 'diagnostics'
  | 'compare'
  // Series de tiempo
  | 'timeIndex'
  | 'timeOrder'
  | 'plotSeries'
  | 'stationarity'
  | 'transform'
  | 'identify'
  | 'arima'
  | 'arimaResiduals'
  | 'forecast';

export type StepKind = 'required' | 'recommended' | 'conditional' | 'optional';

export type StepState =
  | 'done'
  | 'next'
  | 'pending'
  | 'review'
  | 'optional'
  | 'not_applicable'
  | 'blocked';

/** Por qué un paso completado volvió a pedir atención. */
export type ReviewReason = 'doctor_finding' | 'stale';

export type RecommendationKind = 'blocking' | 'advisory' | 'informational' | 'optional';

/**
 * Un requisito es una pregunta con respuesta booleana sobre el contexto, más
 * el texto de qué falta. `describe` se muestra tal cual cuando el paso queda
 * bloqueado, así que se redacta en segunda persona y en términos del usuario.
 */
export interface Requirement {
  id: string;
  describe: string;
  test: (ctx: AnalysisContext) => boolean;
}

/** Acción sugerida. Nunca se ejecuta sola: describe qué control usar. */
export interface ActionRef {
  label: string;
  /** id del elemento de la interfaz al que llevar el foco, si existe. */
  focus?: string;
}

export interface Recommendation {
  id: string;
  ruleId: string;
  kind: RecommendationKind;
  targetStep: StepKey;
  /**
   * Categoría de Model Doctor que originó la recomendación, cuando viene de
   * un hallazgo. Es lo que permite suprimir consejos sobre algo que el
   * estudiante ya atendió (G05) sin tener que adivinar por el texto.
   */
  sourceCategory?: DoctorCategoryKey;
  /** Consecuencia estadística del hallazgo, para ordenar. La define Doctor. */
  impact?: DoctorImpact;
  title: string;
  body: string;
  /** Respuesta a "¿por qué me recomendás esto?". Razón econométrica, no posicional. */
  why: string;
  actions: ActionRef[];
  theory: string[];
  dismissible: boolean;
}

export interface GuidedStep {
  key: StepKey;
  label: string;
  kind: StepKind;
  state: StepState;
  /** Requisitos que NO se cumplen. Vacío salvo que el paso esté bloqueado. */
  unmet: Requirement[];
  reviewReason?: ReviewReason;
  theory: string[];
}

export interface GuidedPlan {
  steps: GuidedStep[];
  primary: Recommendation | null;
  secondary: Recommendation[];
  nextStep: StepKey | null;
  blocked: boolean;
  /** Presente cuando no hay forma de sugerir un próximo paso sensato. */
  cannotAdvise?: { reason: string; whatIsMissing: string };
}

export type DecisionKind =
  | 'load'
  | 'choose_type'
  | 'choose_variables'
  | 'set_spec'
  | 'estimate'
  | 'acknowledge_step'
  | 'dismiss_recommendation'
  /** Cambiar entre guiado y libre. Apagar la guía también es una decisión. */
  | 'set_mode'
  /** Guardar o quitar una estimación del contraste de especificaciones. */
  | 'compare_models';

export interface UserDecision {
  id: string;
  at: number;
  kind: DecisionKind;
  summary: string;
  fromRecommendation?: string;
}

/**
 * Lo que el estudiante ya decidió en esta sesión. Es el único estado mutable
 * de la guía: todo lo demás se deriva del contexto.
 */
export interface GuidedSession {
  mode: GuidedMode;
  confirmedType: AnalysisType | null;
  acknowledged: StepKey[];
  dismissed: string[];
  decisions: UserDecision[];
  /**
   * Firmas distintas que se estimaron en esta sesión.
   *
   * Distintas, no corridas: volver a estimar lo mismo después de arreglar los
   * datos no es haber probado dos especificaciones. Es lo que permite
   * detectar que el estudiante viene pisando modelos sin guardarlos —
   * la pantalla solo muestra el último y los anteriores no dejan rastro.
   */
  estimatedSpecs: string[];
}

/**
 * Firma de la especificación que produjo un resultado. Comparar la firma
 * guardada con la actual es cómo se detecta que lo que está en pantalla quedó
 * viejo — sin esto, el estudiante ve los coeficientes de una especificación
 * junto a los diagnósticos de otra.
 */
export interface SpecSignature {
  dataset: string;
  yName: string;
  xNames: string;
  form: FunctionalForm;
  seType: string;
  dropIncomplete: boolean;
  restriction: string;
  /** Series: qué transformación se está analizando. Vacío en corte transversal. */
  transformation: string;
  /** Series: órdenes del ARIMA, como "p,d,q". Vacío si no hay. */
  arimaOrders: string;
}

export interface DatasetProfileWarning {
  id: string;
  text: string;
  /** Impide estimar hasta que se decida algo. */
  blocking: boolean;
  columns?: string[];
}

export interface DatasetProfile {
  name: string;
  rows: number;
  columns: number;
  numericColumns: string[];
  categoricalColumns: string[];
  hasDates: boolean;
  missingByColumn: Record<string, number>;
  constantColumns: string[];
  warnings: DatasetProfileWarning[];
}

/** Hechos de la serie que está sobre la mesa. */
export interface TimeSeriesFacts {
  dateColumn: string;
  valueColumn: string;
  /** 'original' | 'difference' | 'logReturn' | … tal como lo nombra el panel. */
  transformation: string;
  hasResult: boolean;
  observations: number;
  frequency: string;
  duplicateDates: number;
  invalidDates: number;
  /** Órdenes elegidos si el ARIMA está habilitado (solo Pro). */
  arimaOrders: { p: number; d: number; q: number } | null;
}

export interface CurrentSpec {
  yName: string;
  xNames: string[];
  form: FunctionalForm;
  seType: string;
  dropIncomplete: boolean;
  restriction: string;
  signature: SpecSignature;
}

/**
 * Hechos del contraste de especificaciones.
 *
 * Los produce el motor de comparación, no la guía: acá no se decide si dos
 * modelos son comparables ni se redactan los motivos. Mismo trato que
 * DoctorReport — la guía traduce estados en próximos pasos y nada más.
 */
export interface ComparisonFacts {
  /** Estimaciones guardadas para contrastar. */
  saved: number;
  /** Hay un resultado en pantalla que todavía no se guardó. */
  currentUnsaved: boolean;
  /** Dictamen del motor. null con menos de dos modelos guardados. */
  level: ComparisonLevel | null;
  /** Motivos que impiden comparar de frente, con el texto del motor. */
  blocking: string[];
  /** Motivos que piden cautela, con el texto del motor. */
  cautions: string[];
  /** Coeficientes que cruzan el umbral de significancia según el modelo. */
  significanceFlips: string[];
}

/** Hechos de la sesión. El planificador solo lee de acá. */
export interface AnalysisContext {
  mode: 'regression' | 'timeseries';
  engine: 'lite' | 'pro';
  dataset: DatasetProfile | null;
  /** El ParsedCSV crudo, para reglas que necesiten mirar columnas. */
  raw: ParsedCSV | null;
  spec: CurrentSpec | null;
  /** Firma con la que se produjo el resultado que está en pantalla. */
  estimatedSignature: SpecSignature | null;
  hasResult: boolean;
  /** Presente solo en el flujo de series. */
  timeSeries: TimeSeriesFacts | null;
  doctor: DoctorReport | null;
  /** Presente cuando hay algo guardado o algo para guardar. */
  comparison: ComparisonFacts | null;
  session: GuidedSession;
}
