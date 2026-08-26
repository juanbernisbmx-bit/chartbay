// Estado mutable de la guía. Es lo único que la guía recuerda: todo lo demás
// se deriva del contexto en cada render.
//
// Vive acá y no en appState para que el planificador siga siendo puro y para
// que agregar la guía no obligue a tocar el estado del resto de la app.

import type { DoctorReport } from '../modelDoctor/types';
import type { AnalysisType, GuidedMode, GuidedSession, SpecSignature, StepKey, UserDecision, DecisionKind } from './types';

let session: GuidedSession = {
  mode: 'guided',
  confirmedType: null,
  acknowledged: [],
  dismissed: [],
  decisions: [],
};

/** Firma de la especificación con la que se produjo el resultado en pantalla. */
let estimatedSignature: SpecSignature | null = null;

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
  session.mode = mode;
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
  session = {
    mode: session.mode,
    confirmedType: null,
    acknowledged: [],
    dismissed: [],
    decisions: previous,
  };
  estimatedSignature = null;
  lastDoctorReport = null;
  logDecision('load', `Cargaste ${name}`);
}

/** Solo para tests. */
export function resetSessionForTests(): void {
  session = { mode: 'guided', confirmedType: null, acknowledged: [], dismissed: [], decisions: [] };
  estimatedSignature = null;
  lastDoctorReport = null;
}

function labelOf(type: AnalysisType): string {
  if (type === 'time_series') return 'series de tiempo';
  if (type === 'descriptive') return 'análisis descriptivo';
  return 'corte transversal';
}
