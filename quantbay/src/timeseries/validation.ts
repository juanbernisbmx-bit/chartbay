import type {
  TimeSeriesDataset,
  TimeSeriesRow,
  TimeSeriesValidationIssue,
  TimeSeriesValidationResult,
} from './types';

const DATE_NAME_PATTERN = /(date|fecha|time|timestamp|period|day|month|year)/i;
const DATE_VALUE_PATTERN = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$|^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function isValidDate(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function parseTimeSeriesDate(value: unknown): Date | null {
  if (value instanceof Date) return isValidDate(value) ? new Date(value.getTime()) : null;
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed || !DATE_VALUE_PATTERN.test(trimmed)) return null;

  const parsed = new Date(trimmed);
  return isValidDate(parsed) ? parsed : null;
}

export function detectDateColumn(rows: Record<string, unknown>[], headers?: string[]): string | null {
  const candidateHeaders = headers ?? Object.keys(rows[0] ?? {});
  if (candidateHeaders.length === 0) return null;

  const scored = candidateHeaders.map(header => {
    const values = rows.map(row => row[header]).filter(value => !isMissing(value));
    const parseable = values.filter(value => parseTimeSeriesDate(value) !== null).length;
    const ratio = values.length === 0 ? 0 : parseable / values.length;
    const nameBonus = DATE_NAME_PATTERN.test(header) ? 1 : 0;
    return { header, parseable, ratio, nameBonus };
  });

  const named = scored
    .filter(item => item.nameBonus > 0 && item.parseable > 0)
    .sort((a, b) => b.ratio - a.ratio || b.parseable - a.parseable);
  if (named[0] && named[0].ratio >= 0.5) return named[0].header;

  const inferred = scored
    .filter(item => item.parseable > 0 && item.ratio >= 0.8)
    .sort((a, b) => b.ratio - a.ratio || b.parseable - a.parseable);
  return inferred[0]?.header ?? null;
}

export function sortTimeSeriesRows(rows: TimeSeriesRow[]): TimeSeriesRow[] {
  return [...rows].sort((a, b) => a.date.getTime() - b.date.getTime());
}

export function validateTimeSeriesDataset(
  rows: Record<string, unknown>[],
  valueColumn: string,
  dateColumn = detectDateColumn(rows)
): { dataset: TimeSeriesDataset; validation: TimeSeriesValidationResult } {
  const issues: TimeSeriesValidationIssue[] = [];
  const duplicateDates: string[] = [];
  const missingValueRows: number[] = [];
  const invalidDateRows: number[] = [];
  const validRows: TimeSeriesRow[] = [];
  const seenDates = new Map<string, number>();

  if (rows.length === 0) {
    issues.push({ type: 'empty_series', message: 'Time series is empty.' });
  }

  if (!dateColumn) {
    issues.push({ type: 'missing_date_column', message: 'No parseable date column was detected.' });
  }

  rows.forEach((row, index) => {
    const rawDate = dateColumn ? row[dateColumn] : undefined;
    const rawValue = row[valueColumn];
    const parsedDate = dateColumn ? parseTimeSeriesDate(rawDate) : null;
    const value = Number(rawValue);
    const missingValue = isMissing(rawValue) || Number.isNaN(value) || !Number.isFinite(value);

    if (dateColumn && !parsedDate) {
      invalidDateRows.push(index);
      issues.push({
        type: 'invalid_date',
        message: 'Date value is not parseable.',
        rowIndex: index,
        column: dateColumn,
      });
    }

    if (missingValue) {
      missingValueRows.push(index);
      issues.push({
        type: 'missing_value',
        message: 'Time series value is missing or non-numeric.',
        rowIndex: index,
        column: valueColumn,
      });
    }

    if (!parsedDate || missingValue) return;

    const key = dateKey(parsedDate);
    if (seenDates.has(key)) {
      if (!duplicateDates.includes(key)) duplicateDates.push(key);
      issues.push({
        type: 'duplicate_date',
        message: 'Duplicate date detected.',
        rowIndex: index,
        column: dateColumn ?? undefined,
        dateKey: key,
      });
    } else {
      seenDates.set(key, index);
    }

    validRows.push({
      date: parsedDate,
      value,
      rawDate,
      rawValue,
      original: row,
      index,
    });
  });

  const sortedRows = sortTimeSeriesRows(validRows);
  if (sortedRows.length === 0 && rows.length > 0) {
    issues.push({ type: 'empty_series', message: 'No valid time series observations were found.' });
  }

  if (sortedRows.length < 3) {
    issues.push({
      type: 'insufficient_observations',
      message: 'At least 3 valid observations are required for basic time series analysis.',
    });
  }

  const validation: TimeSeriesValidationResult = {
    isValid: issues.length === 0,
    dateColumn,
    valueColumn,
    issues,
    duplicateDates,
    missingValueRows,
    invalidDateRows,
    validObservationCount: sortedRows.length,
  };

  return {
    dataset: {
      dateColumn,
      valueColumn,
      rows: sortedRows,
    },
    validation,
  };
}
