// Adaptador: arma el AnalysisContext desde el estado real de la app.
//
// Es el único archivo de la guía que toca el DOM y appState. El planificador
// recibe el resultado de acá y no sabe de dónde salió, que es lo que lo
// mantiene puro y testeable sin navegador.

import { $ } from '../app/dom';
import { appState } from '../app/state';
import type { TimeSeriesFacts } from './types';
import { forEachCellOf, rowCountOf, type ParsedCSV } from '../csvParser';
import type { FunctionalForm } from '../functionalForms';
import { getDoctorReport, getEstimatedSignature, getSession } from './session';
import { changedFields } from './invalidation';
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

function intOf(id: string): number | null {
  const raw = ($(id) as HTMLInputElement | null)?.value ?? '';
  const n = Number(raw);
  return raw.trim() !== '' && Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Hechos de la serie, leídos del panel y del último análisis corrido.
 *
 * Nada de esto evalúa: si la serie es estacionaria o no lo dice Model Doctor.
 * Acá solo se registra qué serie se está mirando y con qué transformación.
 */
function timeSeriesFacts(): TimeSeriesFacts | null {
  if (appState.activeMode !== 'timeseries') return null;

  const result = appState.lastTimeSeriesResult;
  const arimaEnabled = ($('qb-pro-ts-arima-enable') as HTMLInputElement | null)?.checked ?? false;
  const p = intOf('qb-pro-ts-arima-p');
  const d = intOf('qb-pro-ts-arima-d');
  const q = intOf('qb-pro-ts-arima-q');

  return {
    dateColumn: ($('qb-ts-date') as HTMLSelectElement | null)?.value ?? '',
    valueColumn: ($('qb-ts-value') as HTMLSelectElement | null)?.value ?? '',
    transformation: ($('qb-ts-transform') as HTMLSelectElement | null)?.value ?? 'original',
    hasResult: result !== null,
    observations: result?.summary.observations ?? 0,
    frequency: String(result?.summary.frequency ?? 'desconocida'),
    duplicateDates: result?.validation.duplicateDates.length ?? 0,
    invalidDates: result?.validation.invalidDateRows.length ?? 0,
    arimaOrders: arimaEnabled && p !== null && d !== null && q !== null ? { p, d, q } : null,
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

  const ts = timeSeriesFacts();
  const signature: SpecSignature = {
    dataset: datasetName,
    yName,
    xNames: xNames.join('|'),
    form,
    seType,
    dropIncomplete,
    restriction,
    // En series, lo que define "qué modelo es este" es la serie analizada:
    // cambiar la transformación abre de nuevo la pregunta de estacionariedad.
    transformation: ts?.transformation ?? '',
    arimaOrders: ts?.arimaOrders ? `${ts.arimaOrders.p},${ts.arimaOrders.d},${ts.arimaOrders.q}` : '',
  };
  return { yName, xNames, form, seType, dropIncomplete, restriction, signature };
}

/** El informe describe la especificación que sigue seleccionada. */
function reportStillApplies(
  spec: CurrentSpec | null,
  estimated: ReturnType<typeof getEstimatedSignature>
): boolean {
  if (!spec || !estimated) return true;
  return changedFields(spec.signature, estimated).length === 0;
}

export function buildAnalysisContext(): AnalysisContext {
  const data = appState.csvData;
  const datasetName = ($('qb-filename')?.textContent ?? '').trim() || 'dataset';
  const profile = data ? buildDatasetProfile(data, datasetName) : null;
  const spec = currentSpec(data, datasetName);
  const estimatedSignature = getEstimatedSignature();

  return {
    mode: appState.activeMode,
    engine: appState.activeVersion === 'pro' ? 'pro' : 'lite',
    dataset: profile,
    raw: data,
    spec,
    estimatedSignature,
    // Hay modelo si estimó cualquiera de los dos motores. No se puede mirar
    // el resultado de Pro directamente —Lite no importa nada de Pro, y hay un
    // test que lo verifica—, así que se usa la firma: la deposita main.ts al
    // terminar una corrida, venga del motor que venga. Sin esto, una corrida
    // Pro dejaba el recorrido trabado en "falta estimar".
    hasResult: appState.lastResult !== null || getEstimatedSignature() !== null,
    timeSeries: timeSeriesFacts(),
    // El DoctorReport tal como lo emite buildModelDoctor, sin transformar —
    // salvo que la especificación haya cambiado desde que se produjo: un
    // diagnóstico de un modelo superado no puede seguir dictando el próximo
    // paso. Se descarta hasta que se vuelva a estimar.
    doctor: reportStillApplies(spec, estimatedSignature) ? getDoctorReport() : null,
    session: getSession(),
  };
}
