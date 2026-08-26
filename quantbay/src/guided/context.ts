// Adaptador: arma el AnalysisContext desde el estado real de la app.
//
// Es el único archivo de la guía que toca el DOM y appState. El planificador
// recibe el resultado de acá y no sabe de dónde salió, que es lo que lo
// mantiene puro y testeable sin navegador.

import { $ } from '../app/dom';
import { appState } from '../app/state';
import { forEachCellOf, rowCountOf, type ParsedCSV } from '../csvParser';
import type { FunctionalForm } from '../functionalForms';
import { getEstimatedSignature, getSession } from './session';
import type { AnalysisContext, AnalysisType, CurrentSpec, DatasetProfile, DatasetProfileWarning, SpecSignature } from './types';

function selectedY(): string {
  return ($('qb-y') as HTMLSelectElement | null)?.value ?? '';
}

function selectedX(yName: string): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('.qb-x-cb:checked'))
    .map(cb => cb.value)
    .filter(v => v !== yName);
}

function categoricalColumns(data: ParsedCSV): string[] {
  const bridged = data as ParsedCSV & { categoricalColumns?: string[] };
  return bridged.categoricalColumns ?? [];
}

/**
 * Cuenta faltantes por columna sobre el DATASET, no sobre la vista previa:
 * en el camino columnar `rows` son 50 filas y un hueco en la fila 80 sería
 * invisible.
 */
function missingByColumn(data: ParsedCSV): Record<string, number> {
  const out: Record<string, number> = {};
  for (const header of data.headers) {
    let missing = 0;
    forEachCellOf(data, header, value => {
      if (value === null || value === undefined || value === '') missing++;
    });
    if (missing > 0) out[header] = missing;
  }
  return out;
}

export function buildDatasetProfile(data: ParsedCSV, name: string): DatasetProfile {
  const missing = missingByColumn(data);
  const rows = rowCountOf(data);
  const dateColumns = data.columns?.dateColumns;
  const constant: string[] = [];

  const warnings: DatasetProfileWarning[] = [];
  const withMissing = Object.keys(missing);
  if (withMissing.length > 0) {
    warnings.push({
      id: 'missing',
      // Bloqueante solo si toca las columnas del modelo: eso lo decide la
      // regla G01, que sí sabe cuáles se eligieron.
      blocking: false,
      columns: withMissing,
      text: `Hay valores faltantes en ${withMissing.length} columna(s).`,
    });
  }

  return {
    name,
    rows,
    columns: data.headers.length,
    numericColumns: data.numericColumns,
    categoricalColumns: categoricalColumns(data),
    hasDates: dateColumns !== undefined && dateColumns.size > 0,
    missingByColumn: missing,
    constantColumns: constant,
    warnings,
  };
}

/** Sugerencia de tipo de análisis, con la evidencia que la respalda. */
export function suggestAnalysisType(profile: DatasetProfile | null): { type: AnalysisType; evidence: string } | null {
  if (!profile) return null;
  if (profile.hasDates && profile.numericColumns.length >= 1) {
    return {
      type: 'time_series',
      evidence: 'el dataset tiene una columna de fechas y al menos una variable numérica',
    };
  }
  if (profile.numericColumns.length >= 2) {
    return {
      type: 'cross_section',
      evidence: `hay ${profile.numericColumns.length} variables numéricas y ninguna columna de fechas`,
    };
  }
  return {
    type: 'descriptive',
    evidence: 'no hay suficientes variables numéricas para una regresión',
  };
}

function currentSpec(data: ParsedCSV | null, datasetName: string): CurrentSpec | null {
  if (!data) return null;
  const yName = selectedY();
  const xNames = selectedX(yName);
  // Del DOM y no de appState: los listeners de la guía corren antes que los
  // de la app, así que appState todavía tiene el valor anterior cuando el
  // estudiante acaba de cambiar el selector. Además, para detectar que los
  // resultados quedaron viejos, lo que importa es lo que está SELECCIONADO,
  // no lo que se estimó.
  const selected = ($('qb-form') as HTMLSelectElement | null)?.value;
  const form = (selected as FunctionalForm | undefined) ?? appState.activeFunctionalForm;
  const seType = ($('qb-pro-se') as HTMLSelectElement | null)?.value ?? 'classic';
  const dropIncomplete = ($('qb-drop-incomplete') as HTMLInputElement | null)?.checked ?? false;
  const restriction = (($('qb-rls-input') as HTMLInputElement | null)?.value ?? '').trim();

  const signature: SpecSignature = {
    dataset: datasetName,
    yName,
    xNames: xNames.join('|'),
    form,
    seType,
    dropIncomplete,
    restriction,
  };
  return { yName, xNames, form, seType, dropIncomplete, restriction, signature };
}

export function buildAnalysisContext(): AnalysisContext {
  const data = appState.csvData;
  const datasetName = ($('qb-filename')?.textContent ?? '').trim() || 'dataset';
  const profile = data ? buildDatasetProfile(data, datasetName) : null;

  return {
    mode: appState.activeMode,
    engine: appState.activeVersion === 'pro' ? 'pro' : 'lite',
    dataset: profile,
    raw: data,
    spec: currentSpec(data, datasetName),
    estimatedSignature: getEstimatedSignature(),
    hasResult: appState.lastResult !== null,
    // Etapa 3 del roadmap: acá se enchufa el DoctorReport tal como lo emite
    // buildModelDoctor, sin transformarlo.
    doctor: null,
    session: getSession(),
  };
}
