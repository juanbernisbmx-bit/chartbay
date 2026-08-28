import { materializeRows, type ParsedCSV } from '../../csvParser';
import type {
  ProArimaForecast,
  ProTimeFrequency,
  ProTimeIndex,
} from './proTimeSeriesResultTypes';

type ProTimeGranularity = 'day' | 'month' | 'year';

interface ParsedProTimeValue {
  label: string;
  sortTime: number;
  year: number;
  month: number;
  day: number;
  granularity: ProTimeGranularity;
}

interface TimePoint {
  parsed: ParsedProTimeValue;
  value: number;
  rowIndex: number;
}

export interface PreparedProTimeSeries {
  values: number[];
  observedValues: number[];
  timeIndex?: ProTimeIndex;
  warnings: string[];
}

export type PrepareProTimeSeriesResult =
  | { ok: true; value: PreparedProTimeSeries }
  | { ok: false; error: string };

const DATE_NAME_PATTERN = /(date|fecha|time|timestamp|period|periodo|día|dia|month|mes|year|año|ano)/i;
const NO_TIME_COLUMN_VALUE = '';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function utcTime(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day);
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function fromYmd(year: number, month: number, day: number, granularity: ProTimeGranularity): ParsedProTimeValue | null {
  if (!isValidYmd(year, month, day)) return null;
  const label = granularity === 'year'
    ? String(year).padStart(4, '0')
    : granularity === 'month'
      ? `${String(year).padStart(4, '0')}-${pad2(month)}`
      : `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  return {
    label,
    sortTime: utcTime(year, month, day),
    year,
    month,
    day,
    granularity,
  };
}

function parseIsoDatetime(value: string): ParsedProTimeValue | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[T\s].+/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return fromYmd(year, month, day, 'day');
}

export function parseProTimeValue(value: unknown): ParsedProTimeValue | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return fromYmd(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(), 'day');
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;

  const text = String(value).trim();
  if (text === '') return null;

  const isoDatetime = parseIsoDatetime(text);
  if (isoDatetime) return isoDatetime;

  let match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    return fromYmd(Number(match[1]), Number(match[2]), Number(match[3]), 'day');
  }

  match = text.match(/^(\d{4})[-/](\d{1,2})$/);
  if (match) {
    return fromYmd(Number(match[1]), Number(match[2]), 1, 'month');
  }

  match = text.match(/^(\d{4})$/);
  if (match) {
    return fromYmd(Number(match[1]), 1, 1, 'year');
  }

  match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = Number(match[3]);
    if (first > 12 && second <= 12) return fromYmd(year, second, first, 'day');
    if (second > 12 && first <= 12) return fromYmd(year, first, second, 'day');
    return null;
  }

  return null;
}

export function detectProTimeColumn(data: ParsedCSV): string | null {
  const scored = data.headers.map(header => {
    const nonMissing = data.rows.map(row => row[header]).filter(value => value !== null && value !== undefined && value !== '');
    const parseable = nonMissing.filter(value => parseProTimeValue(value) !== null).length;
    const ratio = nonMissing.length === 0 ? 0 : parseable / nonMissing.length;
    const nameBonus = DATE_NAME_PATTERN.test(header) ? 1 : 0;
    return { header, parseable, ratio, nameBonus };
  });
  const named = scored
    .filter(item => item.nameBonus > 0 && item.parseable > 0 && item.ratio >= 0.8)
    .sort((a, b) => b.ratio - a.ratio || b.parseable - a.parseable);
  return named[0]?.header ?? null;
}

function monthSerial(parsed: ParsedProTimeValue): number {
  return parsed.year * 12 + (parsed.month - 1);
}

function allSame<T>(values: T[], expected: T): boolean {
  return values.length > 0 && values.every(value => value === expected);
}

function sameDayOrMonthEnd(a: ParsedProTimeValue, b: ParsedProTimeValue): boolean {
  if (a.day === b.day) return true;
  return a.day === daysInMonth(a.year, a.month) && b.day === daysInMonth(b.year, b.month);
}

export function inferProTimeFrequency(points: ParsedProTimeValue[]): ProTimeFrequency {
  if (points.length < 2) return 'unknown';
  const granularities = new Set(points.map(point => point.granularity));
  if (granularities.size > 1) return 'unknown';

  const granularity = points[0].granularity;
  if (granularity === 'year') {
    const yearSteps = points.slice(1).map((point, index) => point.year - points[index].year);
    return allSame(yearSteps, 1) ? 'yearly' : 'unknown';
  }

  const monthSteps = points.slice(1).map((point, index) => monthSerial(point) - monthSerial(points[index]));
  const calendarAligned = points.slice(1).every((point, index) => sameDayOrMonthEnd(points[index], point));
  if (allSame(monthSteps, 1) && (granularity === 'month' || calendarAligned)) return 'monthly';
  if (allSame(monthSteps, 3) && (granularity === 'month' || calendarAligned)) return 'quarterly';
  if (allSame(monthSteps, 12) && (granularity === 'month' || calendarAligned)) return 'yearly';

  if (granularity === 'day') {
    const dayMs = 24 * 60 * 60 * 1000;
    const daySteps = points.slice(1).map((point, index) => Math.round((point.sortTime - points[index].sortTime) / dayMs));
    if (allSame(daySteps, 1)) return 'daily';
    if (allSame(daySteps, 7)) return 'weekly';
  }

  return 'unknown';
}

function addMonthsKeepingCalendar(parsed: ParsedProTimeValue, monthsToAdd: number): ParsedProTimeValue {
  const zeroBased = parsed.year * 12 + (parsed.month - 1) + monthsToAdd;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  const wasMonthEnd = parsed.day === daysInMonth(parsed.year, parsed.month);
  const day = parsed.granularity === 'day'
    ? (wasMonthEnd ? daysInMonth(year, month) : Math.min(parsed.day, daysInMonth(year, month)))
    : 1;
  return fromYmd(year, month, day, parsed.granularity)!;
}

function addDays(parsed: ParsedProTimeValue, days: number): ParsedProTimeValue {
  const date = new Date(parsed.sortTime + days * 24 * 60 * 60 * 1000);
  return fromYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), 'day')!;
}

export function buildFutureProTimeLabels(
  last: ParsedProTimeValue,
  frequency: ProTimeFrequency,
  steps: number
): string[] {
  const labels: string[] = [];
  for (let step = 1; step <= steps; step += 1) {
    if (frequency === 'daily') labels.push(addDays(last, step).label);
    else if (frequency === 'weekly') labels.push(addDays(last, step * 7).label);
    else if (frequency === 'monthly') labels.push(addMonthsKeepingCalendar(last, step).label);
    else if (frequency === 'quarterly') labels.push(addMonthsKeepingCalendar(last, step * 3).label);
    else if (frequency === 'yearly') labels.push(addMonthsKeepingCalendar(last, step * 12).label);
    else labels.push(`t+${step}`);
  }
  return labels;
}

export function applyFuturePeriodsToForecast(
  forecast: ProArimaForecast,
  timeIndex: ProTimeIndex | undefined
): ProArimaForecast {
  if (!timeIndex) return forecast;
  const futureLabels = timeIndex.futureLabels.length >= forecast.items.length
    ? timeIndex.futureLabels
    : Array.from({ length: forecast.items.length }, (_, index) => `t+${index + 1}`);
  return {
    ...forecast,
    items: forecast.items.map((item, index) => ({ ...item, period: futureLabels[index] ?? `t+${item.step}` })),
  };
}

export function prepareProTimeSeriesValues(
  data: ParsedCSV,
  valueColumn: string,
  timeColumn: string | null
): PrepareProTimeSeriesResult {
  // El limpiador WASM conserva sólo 50 filas como vista previa. Pro necesita
  // materializar deliberadamente el dataset entero antes de enviar la serie a
  // statsmodels; de lo contrario el resultado describe otra muestra sin aviso.
  const rows = materializeRows(data, { dates: 'iso' });
  if (!timeColumn) {
    const values = rows.map(row => {
      const raw = row[valueColumn];
      if (raw === null || raw === undefined || raw === '') return NaN;
      const num = Number(raw);
      return Number.isFinite(num) ? num : NaN;
    });
    return { ok: true, value: { values, observedValues: values.filter(Number.isFinite), warnings: [] } };
  }

  if (!data.headers.includes(timeColumn)) {
    return { ok: false, error: 'La columna temporal seleccionada no existe en el CSV.' };
  }

  const points: TimePoint[] = [];
  const duplicateLabels = new Set<string>();
  const seenTimes = new Map<number, string>();
  let droppedValues = 0;
  let invalidDates = 0;

  rows.forEach((row, rowIndex) => {
    const rawValue = row[valueColumn];
    const num = Number(rawValue);
    if (rawValue === null || rawValue === undefined || rawValue === '' || !Number.isFinite(num)) {
      droppedValues += 1;
      return;
    }

    const parsed = parseProTimeValue(row[timeColumn]);
    if (!parsed) {
      invalidDates += 1;
      return;
    }
    const previous = seenTimes.get(parsed.sortTime);
    if (previous) duplicateLabels.add(previous);
    else seenTimes.set(parsed.sortTime, parsed.label);
    points.push({ parsed, value: num, rowIndex });
  });

  if (invalidDates > 0) {
    return {
      ok: false,
      error: 'La columna temporal seleccionada no contiene fechas validas suficientes.',
    };
  }
  if (duplicateLabels.size > 0) {
    return {
      ok: false,
      error: 'La columna temporal contiene fechas duplicadas. Para esta version, usa una observacion por periodo.',
    };
  }
  if (points.length === 0) {
    return {
      ok: false,
      error: 'La columna temporal seleccionada no contiene fechas validas suficientes.',
    };
  }

  const sorted = [...points].sort((a, b) => a.parsed.sortTime - b.parsed.sortTime || a.rowIndex - b.rowIndex);
  const parsedDates = sorted.map(point => point.parsed);
  const frequency = inferProTimeFrequency(parsedDates);
  const timeWarnings: string[] = [];
  if (frequency === 'unknown') {
    timeWarnings.push(
      'No se pudo inferir una frecuencia temporal regular. El forecast se muestra como pasos futuros t+1, t+2, ...'
    );
  }
  const warnings = droppedValues > 0
    ? [`Se descartaron ${droppedValues} observaciones no numericas, faltantes o infinitas.`, ...timeWarnings]
    : timeWarnings;
  const last = parsedDates[parsedDates.length - 1];
  const timeIndex: ProTimeIndex = {
    columnName: timeColumn,
    labels: parsedDates.map(point => point.label),
    frequency,
    futureLabels: buildFutureProTimeLabels(last, frequency, 60),
    warnings: timeWarnings,
  };

  return {
    ok: true,
    value: {
      values: sorted.map(point => point.value),
      observedValues: sorted.map(point => point.value),
      timeIndex,
      warnings,
    },
  };
}

export { NO_TIME_COLUMN_VALUE };
