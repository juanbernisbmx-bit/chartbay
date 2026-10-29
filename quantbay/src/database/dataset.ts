import Papa from 'papaparse';
import { percentReturn, simpleDifference } from '../timeseries/transforms';

export type Frequency = 'Diaria' | 'Mensual' | 'Anual';
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
  paginated?: boolean; page?: number; page_size?: number; total?: number; catalog_total?: number; topics?: string[]; levels?: string[]; frequencies?: string[];
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
  frequency: Frequency; headers: string[]; rows: Array<Array<string | number | null>>; csv: string;
  requestedMonths: number; incompleteMonths: string[]; excludedMonths: string[];
  columns: Array<{ id: string; column: string; name: string; unit: string; transform: Transform; lag: number }>;
}

export function monthIndex(date: string): number {
  if (!/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/.test(date)) throw new Error('El período debe tener un año y un mes válidos.');
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}
function monthPeriod(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}-01`;
}

export function periodIndex(value: string, frequency: Frequency): number {
  if (frequency === 'Mensual') return monthIndex(value);
  if (frequency === 'Anual') {
    if (!/^\d{4}(?:-01-01)?$/.test(value)) throw new Error('El período anual debe indicar un año o el primero de enero.');
    return Number(value.slice(0, 4));
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('La fecha diaria debe indicar año, mes y día.');
  const timestamp = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) throw new Error('Fecha diaria inválida.');
  return timestamp / 86400000;
}
function period(index: number, frequency: Frequency): string {
  return frequency === 'Mensual' ? monthPeriod(index) : frequency === 'Anual' ? `${index}-01-01` : new Date(index * 86400000).toISOString().slice(0, 10);
}
export function periodLabel(value: string, frequency: Frequency): string {
  return frequency === 'Diaria' ? value : value.slice(0, frequency === 'Anual' ? 4 : 7);
}
export function transformLabel(transform: Transform, frequency: Frequency): string {
  return transform === 'monthly' ? `Variación ${frequency === 'Diaria' ? 'diaria' : frequency === 'Anual' ? 'anual' : 'mensual'} (%)` : TRANSFORMS[transform];
}

export function prepareDataset(snapshot: Snapshot, selection: Selection[], options: DatasetOptions): PreparedDataset {
  if (!selection.length) throw new Error('Seleccioná al menos una serie cargada.');
  if (selection.length > 12 || new Set(selection.map(s => s.id)).size !== selection.length) {
    throw new Error('La selección debe tener hasta 12 series diferentes.');
  }
  const first = snapshot.series.find(s => s.id === selection[0].id);
  if (!first?.available || !first.observations.length) throw new Error('Una serie seleccionada todavía no tiene datos.');
  const frequency = first.frequency as Frequency;
  if (!['Diaria', 'Mensual', 'Anual'].includes(frequency)) throw new Error('Frecuencia incompatible.');
  const selected = selection.map(choice => {
    const series = snapshot.series.find(s => s.id === choice.id);
    if (!series?.available || !series.observations.length) throw new Error('Una serie seleccionada todavía no tiene datos.');
    if (series.frequency !== frequency) throw new Error('Seleccioná series de la misma frecuencia: diaria, mensual o anual.');
    if (!Object.prototype.hasOwnProperty.call(TRANSFORMS, choice.transform) || !Number.isInteger(choice.lag) || choice.lag < 0 || choice.lag > 12) {
      throw new Error('Transformación o rezago no válido.');
    }
    const values = new Map<number, number | null>();
    for (const point of series.observations) {
      const index = periodIndex(point.date, frequency);
      if (values.has(index)) throw new Error(`Hay períodos duplicados en ${series.name}.`);
      if (point.value !== null && (typeof point.value !== 'number' || !Number.isFinite(point.value))) {
        throw new Error(`Hay valores no numéricos en ${series.name}.`);
      }
      values.set(index, point.value);
    }
    return { choice, series, values };
  });
  const periods = selected.flatMap(s => [...s.values.keys()]);
  const start = options.start ? periodIndex(options.start, frequency) : periods.reduce((a, b) => Math.min(a, b), Infinity);
  const end = options.end ? periodIndex(options.end, frequency) : periods.reduce((a, b) => Math.max(a, b), -Infinity);
  if (start > end) throw new Error('El período inicial debe ser anterior o igual al final.');
  if (end - start > 50000) throw new Error('El período solicitado es demasiado extenso.');
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
      let previousIndex = target - 1;
      if (choice.transform === 'annual' && frequency === 'Mensual') previousIndex = target - 12;
      if (choice.transform === 'annual' && frequency === 'Diaria') {
        const currentDate = period(target, frequency);
        const lastYear = `${Number(currentDate.slice(0, 4)) - 1}${currentDate.slice(4)}`;
        try { previousIndex = periodIndex(lastYear, frequency); } catch { return null; }
      }
      const previous = values.get(previousIndex);
      if (previous == null) return null;
      return choice.transform === 'difference'
        ? simpleDifference([previous, current])[1]
        : percentReturn([previous, current])[1];
    });
    if (values.some(v => v === null || !Number.isFinite(v))) {
      incompleteMonths.push(period(index, frequency));
      if (options.completeOnly) { excludedMonths.push(period(index, frequency)); continue; }
    }
    rows.push([period(index, frequency), ...values]);
  }
  return { frequency, headers, rows, columns, requestedMonths: end - start + 1, incompleteMonths, excludedMonths,
    csv: Papa.unparse({ fields: headers, data: rows }, { newline: '\n' }) + '\n' };
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
