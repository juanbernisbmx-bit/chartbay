import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PyodideInterface } from '../../src/pro/pyodide/pyodideTypes';

const mocks = vi.hoisted(() => ({
  getPyodide: vi.fn(),
}));

vi.mock('../../src/pro/pyodide/pyodideLoader', () => ({
  getPyodide: mocks.getPyodide,
}));

import { runPyodideTimeSeries } from '../../src/pro/pyodide/pythonTimeSeriesRunner';

// Non-constant, finite series of length n (>= MIN_PRO_TS_OBSERVATIONS).
function makeSeries(n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + i * 0.13);
}

const SERIES = makeSeries(40);

const VALID_TS_PAYLOAD = {
  ok: true,
  engine: 'pyodide',
  variableName: 'serie',
  observations: 40,
  adfRegression: 'c',
  maxLag: 12,
  adf: {
    statistic: -3.5,
    pValue: 0.008,
    usedLag: 1,
    nobs: 38,
    criticalValues: { '1%': -3.6, '5%': -2.9, '10%': -2.6 },
    icBest: 12.3,
  },
  acf: Array.from({ length: 12 }, (_, i) => ({ lag: i + 1, value: 0.5 / (i + 1) })),
  pacf: Array.from({ length: 12 }, (_, i) => ({ lag: i + 1, value: 0.3 / (i + 1) })),
  ljungBox: [
    { lag: 1, statistic: 5.2, pValue: 0.02 },
    { lag: 2, statistic: 6.1, pValue: 0.047 },
    { lag: 3, statistic: 6.5, pValue: 0.09 },
  ],
  warnings: [],
};

function makeFakePyodide(overrides: Partial<PyodideInterface> = {}): PyodideInterface {
  return {
    loadPackage: vi.fn().mockResolvedValue(undefined),
    runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify(VALID_TS_PAYLOAD)),
    globals: { set: vi.fn() },
    ...overrides,
  };
}

function scriptOf(fake: PyodideInterface): string {
  return (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
}

beforeEach(() => {
  mocks.getPyodide.mockReset();
});

describe('runPyodideTimeSeries (statsmodels)', () => {
  it('runs the bridge end to end and sets the Python globals', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const phases: string[] = [];
    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' }, p => phases.push(p));

    expect(result.ok).toBe(true);
    expect(result.observations).toBe(40);
    expect(phases).toEqual(['loading-pyodide', 'loading-packages', 'running']);
    expect(fake.loadPackage).toHaveBeenCalledWith(['numpy', 'pandas', 'statsmodels']);
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_name', 'serie');
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_values_json', JSON.stringify(SERIES));
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_max_lag', 12);
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_adf_regression', 'c');
    expect(fake.globals.set).toHaveBeenCalledWith(
      'chartbay_ts_ljung_box_lags_json',
      JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    );
  });

  it('sends a Python script that uses statsmodels ADF/ACF/PACF/Ljung-Box', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });

    const script = scriptOf(fake);
    expect(script).toContain('from statsmodels.tsa.stattools import adfuller, acf, pacf');
    expect(script).toContain('from statsmodels.stats.diagnostic import acorr_ljungbox');
    expect(script).toContain('adfuller(arr, regression=adf_regression, autolag="AIC")');
    expect(script).toContain('acf(arr, nlags=max_lag, fft=False)');
    expect(script).toContain('pacf(arr, nlags=max_lag, method="ywm")');
    expect(script).toContain('acorr_ljungbox(arr, lags=ljung_box_lags, return_df=True)');
  });

  it('never runs ARIMA — the script has no ARIMA/SARIMAX estimation', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });

    const script = scriptOf(fake);
    expect(script).not.toContain('ARIMA');
    expect(script).not.toContain('SARIMAX');
  });

  it('threads the ADF statistic, p-value and critical values from Python', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });

    expect(result.adf?.statistic).toBe(-3.5);
    expect(result.adf?.pValue).toBe(0.008);
    expect(result.adf?.criticalValues).toEqual({ '1%': -3.6, '5%': -2.9, '10%': -2.6 });
  });

  it('marks ADF rejectAt5 = true for a p-value below 0.05', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(
        JSON.stringify({ ...VALID_TS_PAYLOAD, adf: { ...VALID_TS_PAYLOAD.adf, pValue: 0.01 } })
      ),
    });
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.adf?.rejectAt5).toBe(true);
  });

  it('marks ADF rejectAt5 = false for a p-value at or above 0.05', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(
        JSON.stringify({ ...VALID_TS_PAYLOAD, adf: { ...VALID_TS_PAYLOAD.adf, pValue: 0.42 } })
      ),
    });
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.adf?.rejectAt5).toBe(false);
  });

  it('computes ACF and PACF up to the requested lag', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.acf).toHaveLength(12);
    expect(result.pacf).toHaveLength(12);
    expect(result.acf?.[0].lag).toBe(1);
  });

  it('computes Ljung-Box for multiple lags with per-lag rejectAt5', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.ljungBox).toHaveLength(3);
    expect(result.ljungBox?.[0]).toMatchObject({ lag: 1, rejectAt5: true });
    expect(result.ljungBox?.[2]).toMatchObject({ lag: 3, rejectAt5: false });
  });

  it('blocks a constant series without loading Pyodide', async () => {
    const result = await runPyodideTimeSeries({ values: Array(20).fill(7), variableName: 'serie' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('constante');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('blocks a too-short series without loading Pyodide', async () => {
    const result = await runPyodideTimeSeries({ values: makeSeries(5), variableName: 'serie' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('suficientes observaciones válidas');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('caps a too-high maxLag with a warning and passes the capped value to Python', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie', maxLag: 200 });

    expect(result.ok).toBe(true);
    expect(result.warnings.some(w => w.includes('demasiado alto'))).toBe(true);
    // n=40 → capped to floor(40/2) - 1 = 19.
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_max_lag', 19);
  });

  it('rejects an invalid ADF regression term without loading Pyodide', async () => {
    const result = await runPyodideTimeSeries({
      values: SERIES,
      variableName: 'serie',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adfRegression: 'zzz' as any,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('regresión ADF inválido');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('reports Pyodide load failures without throwing', async () => {
    mocks.getPyodide.mockRejectedValue(new Error('CDN caído'));
    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No se pudo cargar Pyodide');
  });

  it('reports package load failures mentioning statsmodels', async () => {
    const fake = makeFakePyodide({ loadPackage: vi.fn().mockRejectedValue(new Error('sin red')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('numpy/pandas/statsmodels');
  });

  it('reports Python execution failures without throwing', async () => {
    const fake = makeFakePyodide({ runPythonAsync: vi.fn().mockRejectedValue(new Error('SyntaxError')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Error ejecutando diagnósticos de series de tiempo');
  });

  it('passes Python-side controlled errors through', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(
        JSON.stringify({ ok: false, engine: 'pyodide', warnings: [], error: 'La serie es constante.' })
      ),
    });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('La serie es constante.');
  });

  it('re-validates min length and constant series inside the Python script (defense in depth)', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });

    const script = scriptOf(fake);
    expect(script).toContain('if n < 12:');
    expect(script).toContain('np.ptp(arr)');
  });
});
