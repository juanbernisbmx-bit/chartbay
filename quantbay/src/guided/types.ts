// Econometría Guiada — tipos del recorrido.
//
// Ojo con el vocabulario: estos estados describen PROGRESO de la sesión, no
// evidencia estadística. Model Doctor tiene su propio juego de estados (ok,
// problem, mitigated, insufficient…) que habla de los datos. Un paso puede
// estar 'done' y contener un hallazgo 'problem': son ejes distintos y
// mezclarlos es el error más fácil de cometer acá.

import type { ParsedCSV } from '../csvParser';
import type { FunctionalForm } from '../functionalForms';
import type { DoctorReport } from '../modelDoctor/types';

export type AnalysisType = 'cross_section' | 'time_series' | 'descriptive';
export type GuidedMode = 'guided' | 'free';

export type StepKey =
  | 'load'
  | 'profile'
  | 'analysisType'
  | 'variables'
  | 'specification'
  | 'estimate'
  | 'readCoefficients'
  | 'inference'
  | 'diagnostics'
  | 'conclude';

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
  | 'dismiss_recommendation';

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

export interface CurrentSpec {
  yName: string;
  xNames: string[];
  form: FunctionalForm;
  seType: string;
  dropIncomplete: boolean;
  restriction: string;
  signature: SpecSignature;
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
  doctor: DoctorReport | null;
  session: GuidedSession;
}
