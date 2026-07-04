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

  it('imports statsmodels ARIMA but never does auto-ARIMA (no pmdarima/auto_arima)', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });

    const script = scriptOf(fake);
    expect(script).toContain('from statsmodels.tsa.arima.model import ARIMA');
    // Manual ARIMA only — no automatic order selection.
    expect(script).not.toContain('auto_arima');
    expect(script).not.toContain('pmdarima');
  });

  it('estimates ARIMA in Python only when run_arima is set (gated, not automatic)', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });

    const script = scriptOf(fake);
    expect(script).toContain('run_arima = bool(chartbay_ts_run_arima)');
    expect(script).toContain('if run_arima:');
    expect(script).toContain('ARIMA(arr, order=(p, d, q)).fit()');
    // Warnings from statsmodels are captured, not swallowed.
    expect(script).toContain('py_warnings.catch_warnings(record=True)');
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

  describe('ARIMA manual', () => {
    const ARIMA_PAYLOAD = {
      ...VALID_TS_PAYLOAD,
      arima: {
        order: { p: 1, d: 0, q: 1 },
        converged: true,
        nobs: 40,
        logLikelihood: -55.2,
        aic: 118.4,
        bic: 126.1,
        hqic: 121.2,
        coefficients: [
          { name: 'const', estimate: 0.5, standardError: 0.1, zStatistic: 5.0, pValue: 0.001 },
          { name: 'ar.L1', estimate: 0.6, standardError: 0.12, zStatistic: 5.0, pValue: 0.002 },
          { name: 'ma.L1', estimate: -0.3, standardError: 0.15, zStatistic: -2.0, pValue: 0.045 },
          { name: 'sigma2', estimate: 1.2, standardError: 0.2, zStatistic: 6.0, pValue: 0.0 },
        ],
        warnings: [],
      },
      arimaResidualDiagnostics: {
        ljungBox: [
          { lag: 1, statistic: 0.5, pValue: 0.48 },
          { lag: 2, statistic: 1.1, pValue: 0.57 },
        ],
      },
    };

    it('does NOT estimate ARIMA and sets run_arima=false when runArima is absent', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie' });

      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_run_arima', false);
      expect(result.arima).toBeUndefined();
    });

    it('estimates ARIMA and passes the order to Python when runArima is true', async () => {
      const fake = makeFakePyodide({
        runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify(ARIMA_PAYLOAD)),
      });
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({
        values: SERIES,
        variableName: 'serie',
        runArima: true,
        arimaOrder: { p: 1, d: 0, q: 1 },
      });

      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_run_arima', true);
      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_arima_order_json', JSON.stringify({ p: 1, d: 0, q: 1 }));
      expect(result.ok).toBe(true);
      expect(result.arima?.order).toEqual({ p: 1, d: 0, q: 1 });
      expect(result.arima?.aic).toBe(118.4);
      expect(result.arima?.coefficients).toHaveLength(4);
      // Residual Ljung-Box rejectAt5 derived in TS from p-value.
      expect(result.arimaResidualDiagnostics?.ljungBox[0].rejectAt5).toBe(false);
      // Diagnostics remain present alongside ARIMA.
      expect(result.adf).toBeDefined();
    });

    it('reports a controlled arimaError (without touching Python) when the order is invalid, keeping diagnostics', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({
        values: SERIES,
        variableName: 'serie',
        runArima: true,
        arimaOrder: { p: 0, d: 0, q: 0 },
      });

      expect(result.ok).toBe(true);
      expect(result.arima).toBeUndefined();
      expect(result.arimaError).toContain('ARIMA(0,0,0)');
      // Invalid order never reaches Python: run_arima is forced false.
      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_run_arima', false);
      // Diagnostics still computed.
      expect(result.adf).toBeDefined();
    });

    it('threads a Python-side ARIMA estimation failure through as arimaError, keeping diagnostics', async () => {
      const fake = makeFakePyodide({
        runPythonAsync: vi.fn().mockResolvedValue(
          JSON.stringify({
            ...VALID_TS_PAYLOAD,
            arima: null,
            arimaError: 'No se pudo estimar ARIMA con este orden. Probá un modelo más simple.',
          })
        ),
      });
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({
        values: SERIES,
        variableName: 'serie',
        runArima: true,
        arimaOrder: { p: 3, d: 1, q: 2 },
      });

      expect(result.ok).toBe(true);
      expect(result.arima).toBeUndefined();
      expect(result.arimaError).toContain('No se pudo estimar ARIMA');
      expect(result.adf).toBeDefined();
    });

    it('the Python script computes Ljung-Box on the ARIMA residuals', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      await runPyodideTimeSeries({ values: SERIES, variableName: 'serie', runArima: true, arimaOrder: { p: 1, d: 0, q: 1 } });

      const script = scriptOf(fake);
      expect(script).toContain('fit.resid');
      expect(script).toContain('arimaResidualDiagnostics');
      // Convergence is only reported when statsmodels exposes it (never invented).
      expect(script).toContain('mle_retvals');
    });
  });

  describe('ARIMA forecast', () => {
    const FORECAST_BLOCK = {
      steps: 3,
      confidenceLevel: 0.95,
      items: [
        { step: 1, mean: 10.5, meanStandardError: 0.8, lower: 8.9, upper: 12.1 },
        { step: 2, mean: 10.7, meanStandardError: 1.1, lower: 8.5, upper: 12.9 },
        { step: 3, mean: 10.8, meanStandardError: 1.3, lower: 8.2, upper: 13.4 },
      ],
      warnings: [],
    };
    const ARIMA_WITH_FORECAST = {
      ...VALID_TS_PAYLOAD,
      arima: {
        order: { p: 1, d: 0, q: 1 },
        converged: true,
        nobs: 40,
        logLikelihood: -55.2,
        aic: 118.4,
        bic: 126.1,
        hqic: 121.2,
        coefficients: [{ name: 'ar.L1', estimate: 0.6, standardError: 0.12, zStatistic: 5.0, pValue: 0.002 }],
        warnings: [],
        forecast: FORECAST_BLOCK,
      },
    };

    it('returns the forecast and passes the horizon to Python when ARIMA + steps are valid', async () => {
      const fake = makeFakePyodide({
        runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify(ARIMA_WITH_FORECAST)),
      });
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({
        values: SERIES,
        variableName: 'serie',
        runArima: true,
        arimaOrder: { p: 1, d: 0, q: 1 },
        forecastSteps: 3,
      });

      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_forecast_steps', 3);
      expect(result.ok).toBe(true);
      expect(result.arima?.forecast?.steps).toBe(3);
      expect(result.arima?.forecast?.items).toHaveLength(3);
      expect(result.arima?.forecast?.items[0]).toMatchObject({ step: 1, mean: 10.5, lower: 8.9, upper: 12.1 });
      expect(result.arima?.forecast?.confidenceLevel).toBe(0.95);
    });

    it('does NOT request a forecast when ARIMA is not active (steps forced to 0)', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({ values: SERIES, variableName: 'serie', forecastSteps: 12 });

      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_forecast_steps', 0);
      expect(result.arima).toBeUndefined();
    });

    it('an invalid horizon does not block the ARIMA: it runs and only the forecast section errors', async () => {
      const fake = makeFakePyodide({
        runPythonAsync: vi.fn().mockResolvedValue(
          JSON.stringify({ ...ARIMA_WITH_FORECAST, arima: { ...ARIMA_WITH_FORECAST.arima, forecast: undefined } })
        ),
      });
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({
        values: SERIES,
        variableName: 'serie',
        runArima: true,
        arimaOrder: { p: 1, d: 0, q: 1 },
        forecastSteps: 100,
      });

      // ARIMA still runs; forecast never reaches Python.
      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_run_arima', true);
      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_ts_forecast_steps', 0);
      expect(result.ok).toBe(true);
      expect(result.arima).toBeDefined();
      expect(result.arima?.forecast).toBeUndefined();
      expect(result.arima?.forecastError).toContain('hasta 60 períodos');
      // Diagnostics untouched.
      expect(result.adf).toBeDefined();
    });

    it('threads a Python-side forecast failure through as forecastError, keeping the ARIMA result', async () => {
      const fake = makeFakePyodide({
        runPythonAsync: vi.fn().mockResolvedValue(
          JSON.stringify({
            ...ARIMA_WITH_FORECAST,
            arima: {
              ...ARIMA_WITH_FORECAST.arima,
              forecast: undefined,
              forecastError:
                'No se pudo calcular el forecast para este modelo. El ARIMA fue estimado, pero statsmodels no pudo generar predicciones futuras.',
            },
          })
        ),
      });
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideTimeSeries({
        values: SERIES,
        variableName: 'serie',
        runArima: true,
        arimaOrder: { p: 1, d: 0, q: 1 },
        forecastSteps: 12,
      });

      expect(result.ok).toBe(true);
      expect(result.arima?.aic).toBe(118.4);
      expect(result.arima?.forecast).toBeUndefined();
      expect(result.arima?.forecastError).toContain('No se pudo calcular el forecast');
      expect(result.adf).toBeDefined();
    });

    it('the Python script uses get_forecast/summary_frame defensively with conf_int fallback', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      await runPyodideTimeSeries({
        values: SERIES,
        variableName: 'serie',
        runArima: true,
        arimaOrder: { p: 1, d: 0, q: 1 },
        forecastSteps: 12,
      });

      const script = scriptOf(fake);
      expect(script).toContain('fit.get_forecast(steps=forecast_steps)');
      expect(script).toContain('summary_frame(alpha=0.05)');
      // Defensive column candidates + fallbacks (statsmodels versions differ).
      expect(script).toContain('"mean_ci_lower"');
      expect(script).toContain('forecast_res.predicted_mean');
      expect(script).toContain('conf_int(alpha=0.05)');
      // Intervals are never invented: missing CI → nulls + warning.
      expect(script).toContain('no devolvió intervalos de confianza');
    });
  });
});
