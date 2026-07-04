import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PyodideOlsResult } from '../src/pro/pyodide/proResultTypes';
import type { PyodideTimeSeriesResult } from '../src/pro/pyodide/proTimeSeriesResultTypes';
import {
  buildProRegressionCoefficientsCsv,
  buildProRegressionMarkdown,
  buildProRegressionText,
  buildProTimeSeriesAcfPacfCsv,
  buildProTimeSeriesForecastCsv,
  buildProTimeSeriesMarkdown,
  buildProTimeSeriesText,
} from '../src/pro/proExport';
import {
  exportProRegressionCSV,
  exportProRegressionMarkdown,
  exportProTimeSeriesCSV,
  exportProTimeSeriesMarkdown,
  proExportState,
} from '../src/pro/proExportView';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseRegression(): PyodideOlsResult {
  return {
    ok: true,
    engine: 'pyodide',
    functionalForm: 'log-lin',
    yName: 'y',
    xNames: ['x1', 'x2'],
    standardErrorType: 'HC3',
    nobs: 40,
    coefficients: [
      { name: 'const', estimate: 1.234567, stdError: 0.1, tStat: 12.3, pValue: 0.0001 },
      { name: 'x1', estimate: 2.5, stdError: 0.2, tStat: 12.5, pValue: 0.002 },
      { name: 'x2', estimate: -0.75, stdError: null, tStat: null, pValue: null },
    ],
    rSquared: 0.91,
    rSquaredAdj: 0.9,
    fStat: 180.5,
    fPValue: 0.00001,
    dfResid: 37,
    residualStdError: 0.5,
    residuals: [0.1, -0.2, 0.05],
    fitted: [1.0, 2.0, 3.0],
    warnings: [],
  };
}

function fullRegression(): PyodideOlsResult {
  return {
    ...baseRegression(),
    standardErrorType: 'classic',
    rlsTest: { label: 'x1 = 0', fStat: 4.2, fPValue: 0.047, dfNum: 1, dfDenom: 37, reject: true },
    breuschPagan: {
      lmStatistic: 8.1,
      lmPValue: 0.017,
      fStatistic: 4.3,
      fPValue: 0.02,
      rejectAt5: true,
      interpretation: 'Se rechaza homocedasticidad al 5%.',
    },
    categoricalInfo: [
      { originalName: 'region', baseCategory: 'norte', createdDummies: ['region_sur', 'region_este'], categories: ['norte', 'sur', 'este'] },
    ],
  };
}

function baseTimeSeries(): PyodideTimeSeriesResult {
  return {
    ok: true,
    engine: 'pyodide',
    variableName: 'close',
    observations: 120,
    adf: {
      statistic: -3.21,
      pValue: 0.019,
      usedLag: 2,
      nobs: 117,
      criticalValues: { '1%': -3.5, '5%': -2.9, '10%': -2.6 },
      icBest: -100.2,
      rejectAt5: true,
      interpretation: 'Se rechaza H0 al 5%: hay evidencia de estacionariedad.',
    },
    acf: [
      { lag: 1, value: 0.5 },
      { lag: 2, value: 0.2 },
    ],
    pacf: [
      { lag: 1, value: 0.5 },
      { lag: 2, value: -0.1 },
    ],
    ljungBox: [
      { lag: 1, statistic: 10.2, pValue: 0.001, rejectAt5: true, interpretation: 'autocorrelación' },
      { lag: 2, statistic: 12.5, pValue: null, rejectAt5: false, interpretation: 'sin p-value' },
    ],
    warnings: ['Serie corta.'],
  };
}

function timeSeriesWithArima(): PyodideTimeSeriesResult {
  return {
    ...baseTimeSeries(),
    arima: {
      order: { p: 1, d: 0, q: 1 },
      converged: true,
      nobs: 120,
      logLikelihood: -150.2,
      aic: 306.4,
      bic: 312.1,
      hqic: 308.7,
      coefficients: [
        { name: 'ar.L1', estimate: 0.6, standardError: 0.08, zStatistic: 7.5, pValue: 0.0 },
        { name: 'ma.L1', estimate: -0.3, standardError: null, zStatistic: null, pValue: null },
      ],
      warnings: [],
      interpretation: 'ARIMA(1,0,1) combina AR y MA.',
      forecast: {
        steps: 2,
        confidenceLevel: 0.95,
        warnings: [],
        items: [
          { step: 1, mean: 100.5, meanStandardError: 1.2, lower: 98.1, upper: 102.9 },
          { step: 2, mean: 101.0, meanStandardError: null, lower: null, upper: null },
        ],
      },
    },
    arimaResidualDiagnostics: {
      ljungBox: [{ lag: 1, statistic: 0.5, pValue: 0.48, rejectAt5: false, interpretation: 'sin autocorrelación' }],
      interpretation: 'El modelo capturó la dependencia temporal.',
    },
  };
}

// ── Markdown: regresión ───────────────────────────────────────────────────────

describe('buildProRegressionMarkdown', () => {
  it('includes title, Pro engine, functional form, inference and coefficient table', () => {
    const md = buildProRegressionMarkdown(baseRegression());
    expect(md).toContain('# ChartBay Pro — Reporte de regresión');
    expect(md).toContain('Motor: Pro');
    expect(md).toContain('Pyodide + Python + statsmodels');
    expect(md).toContain('Forma funcional: Log-Lin');
    expect(md).toContain('errores estándar robustos HC3');
    expect(md).toContain('| Variable | Coeficiente | Error estándar | t-stat | p-value |');
    expect(md).toContain('| x1 | 2.500000 | 0.200000 | 12.500000 | 0.002000 |');
  });

  it('marks null inference cells as N/D without inventing values', () => {
    const md = buildProRegressionMarkdown(baseRegression());
    expect(md).toContain('| x2 | -0.750000 | N/D | N/D | N/D |');
    expect(md).not.toContain('NaN');
    expect(md).not.toContain('Infinity');
  });

  it('includes categorical, RLS and Breusch-Pagan blocks when present', () => {
    const md = buildProRegressionMarkdown(fullRegression());
    expect(md).toContain('## Variables categóricas');
    expect(md).toContain('Categoría base: norte');
    expect(md).toContain('trampa de dummies');
    expect(md).toContain('## Test de restricción (RLS / Wald-F)');
    expect(md).toContain('H0: x1 = 0');
    expect(md).toContain('Se rechaza H0 al 5%');
    expect(md).toContain('## Breusch-Pagan');
    expect(md).toContain('probá HC3');
  });

  it('omits optional blocks when they are absent', () => {
    const md = buildProRegressionMarkdown(baseRegression());
    expect(md).not.toContain('## Variables categóricas');
    expect(md).not.toContain('## Test de restricción');
    expect(md).not.toContain('## Breusch-Pagan');
    // Notas pedagógicas siempre presentes.
    expect(md).toContain('## Notas de interpretación');
    expect(md).toContain('no causalidad automática');
  });
});

// ── Markdown: series ──────────────────────────────────────────────────────────

describe('buildProTimeSeriesMarkdown', () => {
  it('includes ADF, ACF/PACF, Ljung-Box and pedagogical notes', () => {
    const md = buildProTimeSeriesMarkdown(baseTimeSeries());
    expect(md).toContain('# ChartBay Pro — Reporte de series de tiempo');
    expect(md).toContain('## ADF');
    expect(md).toContain('Estadístico: -3.210000');
    expect(md).toContain('## ACF / PACF');
    expect(md).toContain('| 1 | 0.500000 | 0.500000 |');
    expect(md).toContain('## Ljung-Box');
    expect(md).toContain('| 2 | 12.500000 | N/D | No se rechaza H0 al 5% |');
    expect(md).toContain('## Notas');
    expect(md).toContain('Auto-ARIMA no está implementado todavía.');
  });

  it('includes ARIMA and forecast blocks when ARIMA exists', () => {
    const md = buildProTimeSeriesMarkdown(timeSeriesWithArima());
    expect(md).toContain('## ARIMA');
    expect(md).toContain('Modelo estimado: ARIMA(1,0,1)');
    expect(md).toContain('### Coeficientes ARIMA');
    expect(md).toContain('| ar.L1 | 0.600000 |');
    expect(md).toContain('### Diagnóstico de residuos');
    expect(md).toContain('## Forecast');
    expect(md).toContain('| t+1 | 100.500000 | 1.200000 | 98.100000 | 102.900000 |');
    expect(md).toContain('| t+2 | 101.000000 | N/D | N/D | N/D |');
  });

  it('does not break when ARIMA is absent', () => {
    const md = buildProTimeSeriesMarkdown(baseTimeSeries());
    expect(md).toContain('## ARIMA');
    expect(md).toContain('ARIMA no se estimó en esta corrida.');
    expect(md).not.toContain('## Forecast');
    expect(md).not.toContain('NaN');
  });
});

// ── TXT ───────────────────────────────────────────────────────────────────────

describe('TXT reports', () => {
  it('produces readable plain text for regression', () => {
    const txt = buildProRegressionText(fullRegression());
    expect(txt).toContain('ChartBay Pro - Reporte de regresion');
    expect(txt).toContain('Variable\tCoeficiente\tError estandar\tt-stat\tp-value');
    expect(txt).toContain('Breusch-Pagan');
    expect(txt).not.toContain('|---');
  });

  it('produces readable plain text for series', () => {
    const txt = buildProTimeSeriesText(timeSeriesWithArima());
    expect(txt).toContain('ChartBay Pro - Reporte de series de tiempo');
    expect(txt).toContain('Modelo estimado: ARIMA(1,0,1)');
    expect(txt).toContain('Forecast');
    expect(txt).toContain('Paso\tPronostico\tError estandar\tLimite inferior\tLimite superior');
  });
});

// ── CSV ───────────────────────────────────────────────────────────────────────

describe('CSV reports', () => {
  it('exports regression coefficients with empty cells for null and no NaN/Infinity', () => {
    const csv = buildProRegressionCoefficientsCsv(baseRegression());
    const lines = csv.split('\n');
    expect(lines[0]).toBe('variable,coefficient,standard_error,statistic,p_value');
    expect(lines).toContain('x1,2.5,0.2,12.5,0.002');
    // csvCell prefixes leading '-' with a single quote (spreadsheet-formula guard).
    expect(lines).toContain("x2,'-0.75,,,");
    expect(csv).not.toContain('NaN');
    expect(csv).not.toContain('Infinity');
  });

  it('escapes commas and quotes in coefficient names', () => {
    const result = baseRegression();
    result.coefficients = [{ name: 'a,"b"', estimate: 1, stdError: 2, tStat: 3, pValue: 4 }];
    const csv = buildProRegressionCoefficientsCsv(result);
    expect(csv).toContain('"a,""b""",1,2,3,4');
  });

  it('exports forecast when present with empty cells for null bounds', () => {
    const csv = buildProTimeSeriesForecastCsv(timeSeriesWithArima());
    const lines = csv.split('\n');
    expect(lines[0]).toBe('step,mean,mean_standard_error,lower,upper');
    expect(lines).toContain('1,100.5,1.2,98.1,102.9');
    expect(lines).toContain('2,101,,,');
  });

  it('exports ACF/PACF as the fallback table', () => {
    const csv = buildProTimeSeriesAcfPacfCsv(baseTimeSeries());
    const lines = csv.split('\n');
    expect(lines[0]).toBe('lag,acf,pacf');
    expect(lines).toContain('1,0.5,0.5');
    expect(lines).toContain("2,0.2,'-0.1");
  });
});

// ── UI: download orchestration ────────────────────────────────────────────────

describe('Pro export UI orchestration', () => {
  let downloadedBlob: Blob | null = null;
  let downloadedFilename = '';

  async function downloadedText(): Promise<string> {
    expect(downloadedBlob).not.toBeNull();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(downloadedBlob!);
    });
  }

  beforeEach(() => {
    downloadedBlob = null;
    downloadedFilename = '';
    proExportState.lastProResult = null;
    proExportState.lastProTimeSeriesResult = null;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        downloadedBlob = blob;
        return 'blob:test';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilename = this.download;
    });
  });

  it('downloads the regression markdown with the expected filename', async () => {
    proExportState.lastProResult = fullRegression();
    exportProRegressionMarkdown();
    const text = await downloadedText();
    expect(downloadedFilename).toBe('chartbay_pro_regression_report.md');
    expect(text).toContain('# ChartBay Pro — Reporte de regresión');
  });

  it('downloads the regression coefficients CSV with the expected filename', async () => {
    proExportState.lastProResult = baseRegression();
    exportProRegressionCSV();
    const text = await downloadedText();
    expect(downloadedFilename).toBe('chartbay_pro_regression_coefficients.csv');
    expect(text).toContain('variable,coefficient,standard_error,statistic,p_value');
  });

  it('names the series CSV forecast when a forecast exists', async () => {
    proExportState.lastProTimeSeriesResult = timeSeriesWithArima();
    exportProTimeSeriesCSV();
    await downloadedText();
    expect(downloadedFilename).toBe('chartbay_pro_timeseries_forecast.csv');
  });

  it('falls back to the ACF/PACF CSV when there is no forecast', async () => {
    proExportState.lastProTimeSeriesResult = baseTimeSeries();
    exportProTimeSeriesCSV();
    const text = await downloadedText();
    expect(downloadedFilename).toBe('chartbay_pro_timeseries_acf_pacf.csv');
    expect(text).toContain('lag,acf,pacf');
  });

  it('does not download when there is no Pro result available', () => {
    proExportState.lastProResult = null;
    exportProRegressionMarkdown();
    proExportState.lastProTimeSeriesResult = null;
    exportProTimeSeriesMarkdown();
    expect(downloadedBlob).toBeNull();
    expect(downloadedFilename).toBe('');
  });
});
