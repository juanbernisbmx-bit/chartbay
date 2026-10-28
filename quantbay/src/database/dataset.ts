import Papa from 'papaparse';
import { percentReturn, simpleDifference } from '../timeseries/transforms';

export interface Observation { date: string; value: number | null }
export interface EconomicSeries {
  id: string; name: string; topic: string; level: string; territory: string;
  classification: string; frequency: string; unit: string; basis: string;
  source_id: string; source: string; source_url: string; pending: string;
  release_id?: string;
  available: boolean; status: string; start: string | null; end: string | null; count: number;
  original: { url: string | null; sha256: string | null; retrieved_at: string | null; published_at: string | null } | null;
  license?: string | null; license_url?: string | null; attribution?: string | null;
  sheet: string | null; source_row: number | null; normalization_notes: string[];
  observations: Observation[];
}
export interface Snapshot {
  schema_version: number; release_id: string; source?: 'pilot' | 'supabase' | 'supabase_cache' | 'github' | 'sin_publicaciones'; series: EconomicSeries[];
  paginated?: boolean; page?: number; page_size?: number; total?: number; catalog_total?: number; topics?: string[]; levels?: string[];
}
export const TRANSFORMS = {
  level: 'Nivel original',
  monthly: 'Variación mensual (%)',
  annual: 'Variación interanual (%)',
  difference: 'Primera diferencia',
  log: 'Logaritmo natural',
} as const;
export type Transform = keyof typeof TRANSFORMS;
export interface Selection { id: string; transform: Transform; lag: number }
export interface DatasetOptions { start: string; end: string; completeOnly: boolean }
export interface PreparedDataset {
  headers: string[]; rows: Array<Array<string | number | null>>; csv: string;
  requestedMonths: number; incompleteMonths: string[]; excludedMonths: string[];
  columns: Array<{ id: string; column: string; name: string; unit: string; transform: Transform; lag: number }>;
}

export function monthIndex(date: string): number {
  if (!/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/.test(date)) throw new Error('El período debe tener un año y un mes válidos.');
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}
function period(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}-01`;
}

export function prepareDataset(snapshot: Snapshot, selection: Selection[], options: DatasetOptions): PreparedDataset {
  if (!selection.length) throw new Error('Seleccioná al menos una serie cargada.');
  if (selection.length > 12 || new Set(selection.map(s => s.id)).size !== selection.length) {
    throw new Error('La selección debe tener hasta 12 series diferentes.');
  }
  const selected = selection.map(choice => {
    const series = snapshot.series.find(s => s.id === choice.id);
    if (!series?.available || !series.observations.length) throw new Error('Una serie seleccionada todavía no tiene datos.');
    if (series.frequency !== 'Mensual') throw new Error('Esta versión combina únicamente series mensuales.');
    if (!Object.prototype.hasOwnProperty.call(TRANSFORMS, choice.transform) || !Number.isInteger(choice.lag) || choice.lag < 0 || choice.lag > 12) {
      throw new Error('Transformación o rezago no válido.');
    }
    const values = new Map<number, number | null>();
    for (const point of series.observations) {
      const index = monthIndex(point.date);
      if (values.has(index)) throw new Error(`Hay períodos duplicados en ${series.name}.`);
      if (point.value !== null && (typeof point.value !== 'number' || !Number.isFinite(point.value))) {
        throw new Error(`Hay valores no numéricos en ${series.name}.`);
      }
      values.set(index, point.value);
    }
    return { choice, series, values };
  });
  const periods = selected.flatMap(s => [...s.values.keys()]);
  const start = options.start ? monthIndex(options.start) : Math.min(...periods);
  const end = options.end ? monthIndex(options.end) : Math.max(...periods);
  if (start > end) throw new Error('El período inicial debe ser anterior o igual al final.');
  if (end - start > 12000) throw new Error('El período solicitado es demasiado extenso.');
  const columns = selected.map(({ series, choice }) => ({
    id: series.id, column: `${series.id}${choice.transform === 'level' ? '' : `_${choice.transform}`}${choice.lag ? `_lag${choice.lag}` : ''}`,
    name: series.name, transform: choice.transform, lag: choice.lag,
    unit: choice.transform === 'monthly' || choice.transform === 'annual' ? '%' : choice.transform === 'log' ? 'Logaritmo' : series.unit,
  }));
  const headers = ['fecha', ...columns.map(c => c.column)];
  const rows: PreparedDataset['rows'] = [];
  const incompleteMonths: string[] = [], excludedMonths: string[] = [];
  for (let index = start; index <= end; index++) {
    const values = selected.map(({ choice, values }) => {
      const target = index - choice.lag;
      const current = values.get(target);
      if (current == null) return null;
      if (choice.transform === 'level') return current;
      if (choice.transform === 'log') return current > 0 ? Math.log(current) : null;
      // Look back by calendar month, never by row position across missing periods.
      const previous = values.get(target - (choice.transform === 'annual' ? 12 : 1));
      if (previous == null) return null;
      return choice.transform === 'difference'
        ? simpleDifference([previous, current])[1]
        : percentReturn([previous, current])[1];
    });
    if (values.some(v => v === null || !Number.isFinite(v))) {
      incompleteMonths.push(period(index));
      if (options.completeOnly) { excludedMonths.push(period(index)); continue; }
    }
    rows.push([period(index), ...values]);
  }
  return { headers, rows, columns, requestedMonths: end - start + 1, incompleteMonths, excludedMonths,
    csv: Papa.unparse({ fields: headers, data: rows }, { newline: '\n' }) + '\n' };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
