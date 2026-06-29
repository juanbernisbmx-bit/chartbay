import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegressionResult } from '../src/regression';
import { appState } from '../src/app/state';
import { exportAnalysisCSV, exportAnalysisTXT, csvCell } from '../src/ui/exports';
import { runTimeSeriesAnalysis } from '../src/timeseries/service';

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

function regressionFixture(): RegressionResult {
  return {
    coefficients: [2],
    intercept: 1,
    rSquared: 0.9,
    adjustedRSquared: 0.85,
    predictions: [3, 5, 7],
    residuals: [0.1, -0.1, 0],
    equation: 'y = 1 + 2*x',
    featureNames: ['x'],
    yName: 'y',
    nObs: 3,
    nFeatures: 1,
    stdErrors: [0.1, 0.2],
    tStats: [10, 10],
    pValues: [0.01, 0.01],
    ci95: [[0.8, 1.2], [1.6, 2.4]],
    df: 1,
    sigma2: 0.02,
    fStat: 100,
    fPValue: 0.01,
    method: 'OLS',
  };
}

function randomWalkRows(length: number): Array<{ date: string; close: number }> {
  let level = 100;
  return Array.from({ length }, (_, index) => {
    level += Math.sin(index * 0.73) + Math.cos(index * 0.19) * 0.4 + 0.15;
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      close: level,
    };
  });
}

describe('csvCell', () => {
  beforeEach(() => {
    downloadedBlob = null;
    downloadedFilename = '';
    appState.activeMode = 'regression';
    appState.lastResult = null;
    appState.lastTimeSeriesResult = null;
    appState.lastDropped = 0;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        downloadedBlob = blob;
        return 'blob:test';
      }),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedFilename = this.download;
    });
  });

  it('leaves plain values unchanged', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
  });

  it('quotes commas and escapes quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('prefixes spreadsheet formulas before quoting', () => {
    expect(csvCell('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvCell('-1,2')).toBe(`"'-1,2"`);
  });

  it('exports valid Time Series diagnostics', async () => {
    appState.activeMode = 'timeseries';
    appState.lastTimeSeriesResult = runTimeSeriesAnalysis(
      Array.from({ length: 30 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, '0')}`,
        close: index % 2 === 0 ? 1 : -1,
      })),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 3 }
    );

    exportAnalysisCSV();
    const text = await downloadedText();

    expect(downloadedFilename).toBe('quantbay_time_series.csv');
    expect(text).toContain('time_series,value_column,,close');
    expect(text).toContain('time_series,selected_transformation,,Original series');
    expect(text).toContain('acf,autocorrelation,1');
    expect(text).toContain('pacf,partial_autocorrelation,1');
    expect(text).toContain('ljung_box,q_statistic,5');
    expect(text).toContain('interpretation,pacf');
  });

  it('exports the computed ADF result when available', async () => {
    appState.activeMode = 'timeseries';
    let previous = 0;
    appState.lastTimeSeriesResult = runTimeSeriesAnalysis(
      Array.from({ length: 140 }, (_, index) => {
        previous = 0.55 * previous + Math.sin(index * 1.7) + Math.cos(index * 0.4) * 0.3;
        return {
          date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
          close: previous,
        };
      }),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 12 }
    );

    exportAnalysisCSV();
    const text = await downloadedText();

    expect(appState.lastTimeSeriesResult.adf.available).toBe(true);
    expect(text).toContain('adf,statistic,,');
    expect(text).toContain('adf,lag,,');
    expect(text).toContain('adf,p_value,,N/D');
    expect(text).toContain('adf,verdict,,');
    expect(text).toContain('Critical values');
  });

  it('exports ADF statistic and verdict for a differenced random walk with 140 observations', async () => {
    appState.activeMode = 'timeseries';
    appState.lastTimeSeriesResult = runTimeSeriesAnalysis(
      randomWalkRows(140),
      { dateColumn: 'date', valueColumn: 'close', transformation: 'difference', acfMaxLag: 12 }
    );

    exportAnalysisTXT();
    const text = await downloadedText();

    expect(appState.lastTimeSeriesResult.selectedTransformation.summary.observations).toBe(139);
    expect(appState.lastTimeSeriesResult.adf.available).toBe(true);
    expect(text).toContain('ADF');
    expect(text).toMatch(/Statistic: -?\d+\.\d+/);
    expect(text).toMatch(/Lag: \d+/);
    expect(text).toMatch(/unit root|stationary/i);
    expect(text).not.toContain('ADF no disponible para esta serie.');
  });

  it('exports readable notes when Time Series diagnostics are skipped for small samples', async () => {
    appState.activeMode = 'timeseries';
    appState.lastTimeSeriesResult = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 1 },
        { date: '2024-01-02', close: 2 },
        { date: '2024-01-03', close: 3 },
      ],
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 3 }
    );

    exportAnalysisTXT();
    const text = await downloadedText();

    expect(downloadedFilename).toBe('quantbay_time_series.txt');
    expect(text).toContain('Serie seleccionada: close');
    expect(text).toContain('ACF no disponible');
    expect(text).toContain('PACF no disponible');
    expect(text).toContain('Ljung-Box no disponible');
    expect(text).toContain('at least 4 observations');
  });

  it('exports readable notes for constant Time Series diagnostics', async () => {
    appState.activeMode = 'timeseries';
    appState.lastTimeSeriesResult = runTimeSeriesAnalysis(
      Array.from({ length: 8 }, (_, index) => ({
        date: `2024-01-${String(index + 1).padStart(2, '0')}`,
        close: 7,
      })),
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 3 }
    );

    exportAnalysisCSV();
    const text = await downloadedText();

    expect(text).toContain('note,ACF,,ACF no disponible');
    expect(text).toContain('note,PACF,,PACF no disponible');
    expect(text).toContain('warning,text,,ACF is undefined for a constant transformed series.');
  });

  it('keeps regression export behavior on the regression path', async () => {
    appState.activeMode = 'regression';
    appState.lastResult = regressionFixture();

    exportAnalysisCSV();
    const text = await downloadedText();

    expect(downloadedFilename).toBe('quantbay_resultados.csv');
    expect(text).toContain('model,dependent_variable,,y');
    expect(text).toContain('coefficient,estimate,x,2');
    expect(text).not.toContain('time_series,value_column');
  });
});
