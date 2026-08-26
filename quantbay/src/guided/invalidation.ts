// Qué queda viejo cuando el estudiante cambia algo.
//
// Es la pieza que evita el error más difícil de ver de todos: mirar los
// coeficientes de una especificación junto a los diagnósticos de otra. Todo
// se ve normal, los números están ahí, y no hay nada que delate que
// corresponden a modelos distintos.
//
// La granularidad importa y es contenido pedagógico: cambiar el tipo de
// errores estándar no mueve los coeficientes, así que lo que el estudiante ya
// leyó de ellos sigue valiendo; lo que deja de valer es la inferencia.

import type { SpecSignature, StepKey } from './types';

export type ChangeKind =
  | 'dataset'
  | 'missingPolicy'
  | 'y'
  | 'x'
  | 'form'
  | 'seType'
  | 'restriction';

/** Cómo se nombra cada cambio en los mensajes. */
export const CHANGE_LABEL: Record<ChangeKind, string> = {
  dataset: 'el dataset',
  missingPolicy: 'la política de faltantes',
  y: 'la variable Y',
  x: 'las variables X',
  form: 'la forma funcional',
  seType: 'el tipo de errores estándar',
  restriction: 'la restricción',
};

/**
 * Pasos que deja viejos cada cambio.
 *
 * `estimate` está en todos porque siempre hay que volver a correr. Lo que
 * cambia entre filas es qué lecturas posteriores sobreviven.
 */
const INVALIDATES: Record<ChangeKind, StepKey[]> = {
  // Un dataset nuevo no deja nada en pie, ni siquiera el tipo de análisis.
  dataset: ['profile', 'analysisType', 'variables', 'specification', 'estimate',
            'readCoefficients', 'inference', 'diagnostics', 'conclude'],
  // Cambia la muestra: los coeficientes son otros.
  missingPolicy: ['estimate', 'readCoefficients', 'inference', 'diagnostics', 'conclude'],
  y: ['specification', 'estimate', 'readCoefficients', 'inference', 'diagnostics', 'conclude'],
  x: ['estimate', 'readCoefficients', 'inference', 'diagnostics', 'conclude'],
  form: ['estimate', 'readCoefficients', 'inference', 'diagnostics', 'conclude'],
  // Los coeficientes no se mueven: lo que el estudiante leyó de signo y
  // magnitud sigue siendo válido. Lo que hay que rehacer es la inferencia.
  seType: ['estimate', 'inference', 'diagnostics', 'conclude'],
  // La restricción se contrasta sobre el mismo modelo no restringido.
  restriction: ['estimate', 'inference', 'conclude'],
};

/** Qué campos difieren entre lo que está seleccionado y lo que se estimó. */
export function changedFields(current: SpecSignature, estimated: SpecSignature): ChangeKind[] {
  const changes: ChangeKind[] = [];
  if (current.dataset !== estimated.dataset) changes.push('dataset');
  if (current.yName !== estimated.yName) changes.push('y');
  if (current.xNames !== estimated.xNames) changes.push('x');
  if (current.form !== estimated.form) changes.push('form');
  if (current.seType !== estimated.seType) changes.push('seType');
  if (current.dropIncomplete !== estimated.dropIncomplete) changes.push('missingPolicy');
  if (current.restriction !== estimated.restriction) changes.push('restriction');
  return changes;
}

export function invalidatedSteps(changes: ChangeKind[]): Set<StepKey> {
  const out = new Set<StepKey>();
  for (const change of changes) {
    for (const step of INVALIDATES[change]) out.add(step);
  }
  return out;
}

/** "la forma funcional" · "la variable Y y las variables X" */
export function describeChanges(changes: ChangeKind[]): string {
  const labels = changes.map(c => CHANGE_LABEL[c]);
  if (labels.length === 0) return '';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}

/**
 * Con el tipo de errores estándar como único cambio, los coeficientes siguen
 * siendo los mismos. Vale la pena decirlo: es de las confusiones más comunes.
 */
export function onlyInferenceChanged(changes: ChangeKind[]): boolean {
  return changes.length === 1 && changes[0] === 'seType';
}
