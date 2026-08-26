// Estado mutable de la guía. Es lo único que la guía recuerda: todo lo demás
// se deriva del contexto en cada render.
//
// Vive acá y no en appState para que el planificador siga siendo puro y para
// que agregar la guía no obligue a tocar el estado del resto de la app.

import type { DoctorReport } from '../modelDoctor/types';
import { changedFields } from './invalidation';
import { describeEstimation, describeSpecChanges } from './decisionLog';
import { loadStoredMode, storeMode } from './persistence';
import type { AnalysisType, CurrentSpec, GuidedMode, GuidedSession, SpecSignature, StepKey, UserDecision, DecisionKind } from './types';

function emptySession(mode: GuidedMode = 'guided'): GuidedSession {
  return { mode, confirmedType: null, acknowledged: [], dismissed: [], decisions: [], estimatedSpecs: [] };
}

let session: GuidedSession = emptySession();

/** Identidad de una especificación, para saber si ya se estimó esta sesión. */
function specKey(signature: SpecSignature): string {
  return [
    signature.dataset, signature.yName, signature.xNames, signature.form,
    signature.dropIncomplete, signature.restriction, signature.transformation,
    signature.arimaOrders,
    // El tipo de errores estándar queda afuera a propósito: no mueve los
    // coeficientes, así que estimar lo mismo con HC3 no es haber probado otra
    // especificación — es haber cambiado cómo se hace la inferencia.
  ].join('|');
}

/** Firma de la especificación con la que se produjo el resultado en pantalla. */
let estimatedSignature: SpecSignature | null = null;

/**
 * Firma contra la que se mide el próximo cambio de especificación.
 *
 * No es la estimada: el estudiante puede tocar tres controles sin estimar
 * ninguna vez, y cada uno de esos toques es una decisión. Sin esta línea de
 * base aparte, el registro compararía siempre contra la última corrida y
 * anotaría el mismo cambio una y otra vez.
 */
let lastLoggedSignature: SpecSignature | null = null;

/**
 * Último diagnóstico que se le mostró al estudiante.
 *
 * Lo deposita renderModelDoctor, que es por donde pasan los cuatro caminos
 * que construyen un informe (Lite, Pro, series y series Pro). La guía lo lee
 * tal cual: no reconstruye el informe ni reimplementa nada de Model Doctor.
 */
let lastDoctorReport: DoctorReport | null = null;


export function noteDoctorReport(report: DoctorReport): void {
  lastDoctorReport = report;
}

export function getDoctorReport(): DoctorReport | null {
  return lastDoctorReport;
}

export function getSession(): GuidedSession {
  return session;
}

export function getEstimatedSignature(): SpecSignature | null {
  return estimatedSignature;
}

export function recordEstimation(signature: SpecSignature): void {
  estimatedSignature = signature;
  const key = specKey(signature);
  if (!session.estimatedSpecs.includes(key)) session.estimatedSpecs.push(key);
  // Lo estimado pasa a ser la línea de base: los cambios que vengan después se
  // cuentan desde acá, no desde lo que hubiera seleccionado antes de correr.
  lastLoggedSignature = signature;
  logDecision('estimate', describeEstimation(signature));
}

/**
 * Anota los cambios de especificación que hizo el estudiante.
 *
 * Lo llama la vista ante eventos `change` —nunca `input`—: escribir una
 * restricción letra por letra no son veinte decisiones, es una.
 *
 * Se separan variables y resto porque son decisiones de distinta naturaleza:
 * elegir qué explica qué es una decisión de modelo; elegir errores robustos o
 * una forma funcional es una decisión sobre cómo estimarlo.
 */
export function noteSpecChange(spec: CurrentSpec | null): void {
  if (!spec) return;
  const previous = lastLoggedSignature;
  lastLoggedSignature = spec.signature;

  // Sin línea de base no hubo cambio del estudiante: la primera firma es el
  // punto de partida que dejó la carga del dataset, no algo que él eligió. Un
  // dataset distinto tampoco se compara: ya lo anotó resetForNewDataset.
  if (!previous || previous.dataset !== spec.signature.dataset) return;

  // Cruzar entre corte transversal y series no es "cambiar la transformación":
  // es cambiar de flujo, y los campos que la firma llena pasan a ser otros.
  // Se re-basa la línea y no se anota nada del salto en sí.
  if ((previous.transformation === '') !== (spec.signature.transformation === '')) return;

  const changes = changedFields(spec.signature, previous);
  if (changes.length === 0) return;

  const variables = changes.filter(c => c === 'y' || c === 'x');
  const rest = changes.filter(c => c !== 'y' && c !== 'x');
  if (variables.length > 0) {
    logDecision('choose_variables', `Cambiaste ${describeSpecChanges(variables, spec.signature)}`);
  }
  if (rest.length > 0) {
    logDecision('set_spec', `Cambiaste ${describeSpecChanges(rest, spec.signature)}`);
  }
}

/**
 * Fija la línea de base sin registrar nada.
 *
 * La llama la vista al dibujar: después de cargar un dataset, la selección
 * automática de Y y X no la decidió el estudiante, pero es contra ella que hay
 * que medir su primer cambio. Sin esto, la primera decisión real se perdería
 * por no tener contra qué compararla.
 */
export function seedSpecBaseline(spec: CurrentSpec | null): void {
  if (!spec || lastLoggedSignature) return;
  lastLoggedSignature = spec.signature;
}

export function confirmAnalysisType(type: AnalysisType, suggested: AnalysisType | null): void {
  session.confirmedType = type;
  logDecision('choose_type', type === suggested
    ? `Confirmaste ${labelOf(type)} (sugerido)`
    : `Elegiste ${labelOf(type)} (sugerido: ${suggested ? labelOf(suggested) : 'ninguno'})`);
}

export function acknowledgeStep(step: StepKey, label: string, fromRecommendation?: string): void {
  if (!session.acknowledged.includes(step)) session.acknowledged.push(step);
  logDecision('acknowledge_step', `Revisaste ${label}`, fromRecommendation);
}

export function dismissRecommendation(id: string, title: string): void {
  if (!session.dismissed.includes(id)) session.dismissed.push(id);
  logDecision('dismiss_recommendation', `Continuaste sin atender: ${title}`, id);
}

export function setMode(mode: GuidedMode): void {
  if (session.mode === mode) return;
  session.mode = mode;
  storeMode(mode);
  // Apagar la guía es en sí una decisión del recorrido, y de las que más
  // explican después por qué nadie avisó de algo. Queda anotada como cualquier
  // otra.
  logDecision('set_mode', mode === 'free'
    ? 'Pasaste a modo libre: la guía solo avisa lo que invalidaría el análisis'
    : 'Volviste al modo guiado');
}

/**
 * Restaura las preferencias guardadas. La llama la vista al iniciar.
 *
 * No registra decisión: recuperar lo que el estudiante ya había elegido no es
 * una elección nueva, y anotarla llenaría el registro de ruido en cada recarga.
 */
export function restoreGuidedPreferences(): void {
  const stored = loadStoredMode();
  if (stored) session.mode = stored;
}

export function logDecision(kind: DecisionKind, summary: string, fromRecommendation?: string): void {
  const entry: UserDecision = {
    id: `${kind}:${session.decisions.length + 1}`,
    at: Date.now(),
    kind,
    summary,
    fromRecommendation,
  };
  session.decisions.push(entry);
}

/**
 * Un dataset nuevo invalida todo el recorrido. No se borra el historial: se
 * deja el corte anotado, para que el registro siga contando la sesión entera.
 */
export function resetForNewDataset(name: string): void {
  const previous = session.decisions;
  session = { ...emptySession(session.mode), decisions: previous };
  estimatedSignature = null;
  lastLoggedSignature = null;
  lastDoctorReport = null;
  logDecision('load', `Cargaste ${name}`);
}

/** Solo para tests. */
export function resetSessionForTests(): void {
  session = emptySession();
  estimatedSignature = null;
  lastLoggedSignature = null;
  lastDoctorReport = null;
}

function labelOf(type: AnalysisType): string {
  if (type === 'time_series') return 'series de tiempo';
  if (type === 'descriptive') return 'análisis descriptivo';
  return 'corte transversal';
}
