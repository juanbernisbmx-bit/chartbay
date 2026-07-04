// Estado y orquestación de descargas de exportación de ChartBay Pro. Vive bajo
// src/pro/ (no en el estado global de Lite) para no acoplar el estado compartido
// a los tipos del motor Pyodide: sólo el motor Pro conoce estos resultados.
//
// proExportState guarda el último resultado Pro exitoso (regresión y series);
// las funciones export* leen ese estado, construyen el reporte con las funciones
// puras de proExport.ts y disparan la descarga. Sin resultado disponible avisan
// con showError y no descargan nada.

import { showError } from '../app/dom';
import { downloadTextFile } from '../ui/exports';
import type { PyodideOlsResult } from './pyodide/proResultTypes';
import type { PyodideTimeSeriesResult } from './pyodide/proTimeSeriesResultTypes';
import {
  buildProRegressionCoefficientsCsv,
  buildProRegressionMarkdown,
  buildProRegressionText,
  buildProTimeSeriesAcfPacfCsv,
  buildProTimeSeriesForecastCsv,
  buildProTimeSeriesMarkdown,
  buildProTimeSeriesText,
  hasProForecast,
} from './proExport';

export interface ProExportState {
  lastProResult: PyodideOlsResult | null;
  lastProTimeSeriesResult: PyodideTimeSeriesResult | null;
}

export const proExportState: ProExportState = {
  lastProResult: null,
  lastProTimeSeriesResult: null,
};

const MD_MIME = 'text/markdown';
const TXT_MIME = 'text/plain';
const CSV_MIME = 'text/csv';

const NO_REGRESSION = 'Primero ejecutá una regresión Pro para poder exportar.';
const NO_TIME_SERIES = 'Primero ejecutá un diagnóstico de series Pro para poder exportar.';

// ── Regresión Pro ─────────────────────────────────────────────────────────────

export function exportProRegressionMarkdown(): void {
  const result = proExportState.lastProResult;
  if (!result || !result.ok) { showError(NO_REGRESSION); return; }
  downloadTextFile('chartbay_pro_regression_report.md', buildProRegressionMarkdown(result), MD_MIME);
}

export function exportProRegressionTXT(): void {
  const result = proExportState.lastProResult;
  if (!result || !result.ok) { showError(NO_REGRESSION); return; }
  downloadTextFile('chartbay_pro_regression_report.txt', buildProRegressionText(result), TXT_MIME);
}

export function exportProRegressionCSV(): void {
  const result = proExportState.lastProResult;
  if (!result || !result.ok) { showError(NO_REGRESSION); return; }
  downloadTextFile('chartbay_pro_regression_coefficients.csv', buildProRegressionCoefficientsCsv(result), CSV_MIME);
}

// ── Series de tiempo Pro ──────────────────────────────────────────────────────

export function exportProTimeSeriesMarkdown(): void {
  const result = proExportState.lastProTimeSeriesResult;
  if (!result || !result.ok) { showError(NO_TIME_SERIES); return; }
  downloadTextFile('chartbay_pro_timeseries_report.md', buildProTimeSeriesMarkdown(result), MD_MIME);
}

export function exportProTimeSeriesTXT(): void {
  const result = proExportState.lastProTimeSeriesResult;
  if (!result || !result.ok) { showError(NO_TIME_SERIES); return; }
  downloadTextFile('chartbay_pro_timeseries_report.txt', buildProTimeSeriesText(result), TXT_MIME);
}

// CSV principal de series: forecast si existe, en caso contrario ACF/PACF. El
// nombre del archivo refleja el contenido efectivamente exportado.
export function exportProTimeSeriesCSV(): void {
  const result = proExportState.lastProTimeSeriesResult;
  if (!result || !result.ok) { showError(NO_TIME_SERIES); return; }
  if (hasProForecast(result)) {
    downloadTextFile('chartbay_pro_timeseries_forecast.csv', buildProTimeSeriesForecastCsv(result), CSV_MIME);
  } else {
    downloadTextFile('chartbay_pro_timeseries_acf_pacf.csv', buildProTimeSeriesAcfPacfCsv(result), CSV_MIME);
  }
}
