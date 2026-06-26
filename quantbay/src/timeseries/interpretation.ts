import type { TimeSeriesAnalysisResult, TimeSeriesFrequency, TimeSeriesSummary, TimeSeriesValidationResult } from './types';

function formatDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : 'N/D';
}

function frequencyLabel(frequency: TimeSeriesFrequency): string {
  switch (frequency) {
    case 'daily':
      return 'daily';
    case 'weekly':
      return 'weekly';
    case 'monthly':
      return 'monthly';
    case 'quarterly':
      return 'quarterly';
    case 'yearly':
      return 'yearly';
    case 'irregular':
      return 'irregular';
    default:
      return 'unknown';
  }
}

export function interpretTimeSeriesSummary(
  summary: TimeSeriesSummary,
  validation: TimeSeriesValidationResult
): string[] {
  const lines = [
    `Observations: ${summary.observations}.`,
    `Date range: ${formatDate(summary.startDate)} to ${formatDate(summary.endDate)}.`,
  ];

  if (summary.frequency !== 'unknown') {
    lines.push(`Approximate frequency: ${frequencyLabel(summary.frequency)}.`);
  }

  if (validation.duplicateDates.length > 0) {
    lines.push(`Warning: duplicate dates detected (${validation.duplicateDates.length}).`);
  }

  if (validation.missingValueRows.length > 0 || validation.invalidDateRows.length > 0) {
    lines.push('Warning: missing or invalid observations were detected.');
  }

  if (validation.validObservationCount < 3) {
    lines.push('Warning: fewer than 3 valid observations are available.');
  }

  return lines;
}

export function interpretTimeSeriesAnalysis(result: TimeSeriesAnalysisResult): string[] {
  return interpretTimeSeriesSummary(result.summary, result.validation);
}
