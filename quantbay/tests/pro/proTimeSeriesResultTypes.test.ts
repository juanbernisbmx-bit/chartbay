import { describe, expect, it } from 'vitest';
import {
  adfRejectsAt5,
  interpretAdf,
  interpretArima,
  interpretLjungBox,
  ljungBoxRejectsAt5,
  normalizePyodideTimeSeriesResult,
} from '../../src/pro/pyodide/proTimeSeriesResultTypes';

const VALID_PAYLOAD = {
  ok: true,
  engine: 'pyodide',
  variableName: 'serie',
  observations: 40,
  adfRegression: 'c',
  maxLag: 3,
  adf: {
    statistic: -3.5,
    pValue: 0.008,
    usedLag: 1,
    nobs: 38,
    criticalValues: { '1%': -3.6, '5%': -2.9, '10%': -2.6 },
    icBest: 12.3,
  },
  acf: [
    { lag: 1, value: 0.5 },
    { lag: 2, value: 0.25 },
    { lag: 3, value: 0.1 },
  ],
  pacf: [
    { lag: 1, value: 0.5 },
    { lag: 2, value: -0.1 },
    { lag: 3, value: 0.02 },
  ],
  ljungBox: [
    { lag: 1, statistic: 5.2, pValue: 0.02 },
    { lag: 2, statistic: 6.1, pValue: 0.047 },
    { lag: 3, statistic: 6.5, pValue: 0.09 },
  ],
  warnings: [],
};

function normalize(payload: unknown) {
  return normalizePyodideTimeSeriesResult(JSON.stringify(payload));
}

describe('normalizePyodideTimeSeriesResult', () => {
  it('parses a full valid payload (ADF, ACF, PACF, Ljung-Box)', () => {
    const result = normalize(VALID_PAYLOAD);
    expect(result.ok).toBe(true);
    expect(result.variableName).toBe('serie');
    expect(result.observations).toBe(40);
    expect(result.adfRegression).toBe('c');
    expect(result.maxLag).toBe(3);
  });

  it('returns ADF statistic, p-value, used lag, nobs and critical values', () => {
    const result = normalize(VALID_PAYLOAD);
    expect(result.adf?.statistic).toBe(-3.5);
    expect(result.adf?.pValue).toBe(0.008);
    expect(result.adf?.usedLag).toBe(1);
    expect(result.adf?.nobs).toBe(38);
    expect(result.adf?.criticalValues).toEqual({ '1%': -3.6, '5%': -2.9, '10%': -2.6 });
    expect(result.adf?.icBest).toBe(12.3);
  });

  it('marks ADF rejectAt5 = true when p-value < 0.05', () => {
    const result = normalize({ ...VALID_PAYLOAD, adf: { ...VALID_PAYLOAD.adf, pValue: 0.008 } });
    expect(result.adf?.rejectAt5).toBe(true);
    expect(result.adf?.interpretation).toContain('Se rechaza H0 al 5%');
  });

  it('marks ADF rejectAt5 = false when p-value >= 0.05', () => {
    const result = normalize({ ...VALID_PAYLOAD, adf: { ...VALID_PAYLOAD.adf, pValue: 0.2 } });
    expect(result.adf?.rejectAt5).toBe(false);
    expect(result.adf?.interpretation).toContain('No se rechaza H0 al 5%');
  });

  it('handles a null ADF p-value (serialized non-finite) without rejecting', () => {
    const result = normalize({ ...VALID_PAYLOAD, adf: { ...VALID_PAYLOAD.adf, pValue: null } });
    expect(result.adf?.pValue).toBeNull();
    expect(result.adf?.rejectAt5).toBe(false);
    expect(result.adf?.interpretation).toContain('no está disponible');
  });

  it('parses ACF up to the requested lag', () => {
    const result = normalize(VALID_PAYLOAD);
    expect(result.acf).toHaveLength(3);
    expect(result.acf?.[0]).toEqual({ lag: 1, value: 0.5 });
    expect(result.acf?.[2]).toEqual({ lag: 3, value: 0.1 });
  });

  it('parses PACF up to the requested lag', () => {
    const result = normalize(VALID_PAYLOAD);
    expect(result.pacf).toHaveLength(3);
    expect(result.pacf?.map(p => p.lag)).toEqual([1, 2, 3]);
  });

  it('parses Ljung-Box rows and derives rejectAt5 per lag from the p-value', () => {
    const result = normalize(VALID_PAYLOAD);
    expect(result.ljungBox).toHaveLength(3);
    expect(result.ljungBox?.[0]).toMatchObject({ lag: 1, statistic: 5.2, pValue: 0.02, rejectAt5: true });
    expect(result.ljungBox?.[1]).toMatchObject({ lag: 2, pValue: 0.047, rejectAt5: true });
    expect(result.ljungBox?.[2]).toMatchObject({ lag: 3, pValue: 0.09, rejectAt5: false });
  });

  it('threads an ok:false Python error through as an error result', () => {
    const result = normalize({ ok: false, engine: 'pyodide', warnings: [], error: 'La serie es constante.' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('La serie es constante.');
  });

  it('leaves a diagnostic undefined when Python could not compute it (null)', () => {
    const result = normalize({ ...VALID_PAYLOAD, pacf: null });
    expect(result.ok).toBe(true);
    expect(result.pacf).toBeUndefined();
    expect(result.acf).toBeDefined();
  });

  it('rejects a non-JSON payload with a clear message', () => {
    const result = normalizePyodideTimeSeriesResult('not json {');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ilegible');
  });

  it('rejects an empty payload', () => {
    const result = normalizePyodideTimeSeriesResult('');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no devolvió resultados');
  });

  it('rejects a malformed ADF block (bad usedLag)', () => {
    const result = normalize({ ...VALID_PAYLOAD, adf: { ...VALID_PAYLOAD.adf, usedLag: 'x' } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ADF inválido');
  });
});

describe('interpretation helpers', () => {
  it('adfRejectsAt5 reflects the 5% threshold', () => {
    expect(adfRejectsAt5(0.049)).toBe(true);
    expect(adfRejectsAt5(0.05)).toBe(false);
    expect(adfRejectsAt5(null)).toBe(false);
  });

  it('interpretAdf covers reject / no-reject / unavailable', () => {
    expect(interpretAdf(0.01)).toContain('Se rechaza H0');
    expect(interpretAdf(0.6)).toContain('No se rechaza H0');
    expect(interpretAdf(null)).toContain('no está disponible');
  });

  it('ljungBoxRejectsAt5 reflects the 5% threshold', () => {
    expect(ljungBoxRejectsAt5(0.049)).toBe(true);
    expect(ljungBoxRejectsAt5(0.2)).toBe(false);
    expect(ljungBoxRejectsAt5(null)).toBe(false);
  });

  it('interpretLjungBox covers reject / no-reject / unavailable', () => {
    expect(interpretLjungBox(0.01)).toContain('Se rechaza H0');
    expect(interpretLjungBox(0.6)).toContain('No se rechaza H0');
    expect(interpretLjungBox(null)).toContain('no disponible');
  });

  it('interpretArima describes p/d/q and notes non-convergence and differencing', () => {
    const converged = interpretArima({ p: 1, d: 0, q: 1 }, true);
    expect(converged).toContain('ARIMA(1,0,1)');
    expect(converged).toContain('AR(1)');
    expect(converged).not.toContain('no convergió');

    const notConverged = interpretArima({ p: 2, d: 1, q: 0 }, false);
    expect(notConverged).toContain('serie diferenciada');
    expect(notConverged).toContain('no convergió');
  });
});

describe('normalizePyodideTimeSeriesResult · ARIMA', () => {
  const ARIMA_BLOCK = {
    order: { p: 1, d: 0, q: 1 },
    converged: true,
    nobs: 40,
    logLikelihood: -55.2,
    aic: 118.4,
    bic: 126.1,
    hqic: 121.2,
    coefficients: [
      { name: 'ar.L1', estimate: 0.6, standardError: 0.12, zStatistic: 5.0, pValue: 0.002 },
      { name: 'sigma2', estimate: 1.2, standardError: 0.2, zStatistic: 6.0, pValue: 0.0 },
    ],
    warnings: ['Optimization failed to converge.'],
  };

  function normalizeWithArima(extra: Record<string, unknown>) {
    return normalizePyodideTimeSeriesResult(JSON.stringify({ ...VALID_PAYLOAD, ...extra }));
  }

  it('parses a full ARIMA block and derives its interpretation', () => {
    const result = normalizeWithArima({ arima: ARIMA_BLOCK });
    expect(result.ok).toBe(true);
    expect(result.arima?.order).toEqual({ p: 1, d: 0, q: 1 });
    expect(result.arima?.aic).toBe(118.4);
    expect(result.arima?.coefficients).toHaveLength(2);
    expect(result.arima?.converged).toBe(true);
    expect(result.arima?.interpretation).toContain('ARIMA(1,0,1)');
    expect(result.arima?.warnings).toEqual(['Optimization failed to converge.']);
  });

  it('converts non-finite ARIMA statistics to null (serialized as null by Python)', () => {
    const result = normalizeWithArima({
      arima: {
        ...ARIMA_BLOCK,
        aic: null,
        coefficients: [{ name: 'ar.L1', estimate: 0.6, standardError: null, zStatistic: null, pValue: null }],
      },
    });
    expect(result.ok).toBe(true);
    expect(result.arima?.aic).toBeNull();
    expect(result.arima?.coefficients[0].standardError).toBeNull();
    expect(result.arima?.coefficients[0].pValue).toBeNull();
  });

  it('does not throw when convergence/nobs are absent (optional fields)', () => {
    const result = normalizeWithArima({
      arima: { order: { p: 1, d: 0, q: 1 }, logLikelihood: -10, aic: 25, bic: 28, hqic: 26, coefficients: [], warnings: [] },
    });
    expect(result.ok).toBe(true);
    expect(result.arima?.converged).toBeUndefined();
    expect(result.arima?.nobs).toBeUndefined();
  });

  it('leaves arima undefined when the payload has no ARIMA block', () => {
    const result = normalizeWithArima({});
    expect(result.ok).toBe(true);
    expect(result.arima).toBeUndefined();
    expect(result.arimaError).toBeUndefined();
  });

  it('threads an arimaError through and keeps diagnostics intact', () => {
    const result = normalizeWithArima({ arima: null, arimaError: 'No se pudo estimar ARIMA con este orden.' });
    expect(result.ok).toBe(true);
    expect(result.arima).toBeUndefined();
    expect(result.arimaError).toContain('No se pudo estimar ARIMA');
    // Diagnostics from VALID_PAYLOAD are still present.
    expect(result.adf).toBeDefined();
    expect(result.ljungBox).toBeDefined();
  });

  it('parses ARIMA residual Ljung-Box and derives rejectAt5 + interpretation', () => {
    const result = normalizeWithArima({
      arima: ARIMA_BLOCK,
      arimaResidualDiagnostics: {
        ljungBox: [
          { lag: 1, statistic: 0.5, pValue: 0.48 },
          { lag: 2, statistic: 6.0, pValue: 0.01 },
        ],
      },
    });
    expect(result.arimaResidualDiagnostics?.ljungBox[0].rejectAt5).toBe(false);
    expect(result.arimaResidualDiagnostics?.ljungBox[1].rejectAt5).toBe(true);
    expect(result.arimaResidualDiagnostics?.interpretation).toContain('autocorrelación');
  });

  it('rejects a malformed ARIMA block (bad order)', () => {
    const result = normalizeWithArima({ arima: { ...ARIMA_BLOCK, order: { p: -1, d: 0, q: 1 } } });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ARIMA inválido');
  });

  describe('forecast', () => {
    const FORECAST_BLOCK = {
      steps: 2,
      confidenceLevel: 0.95,
      items: [
        { step: 1, mean: 10.5, meanStandardError: 0.8, lower: 8.9, upper: 12.1 },
        { step: 2, mean: 10.7, meanStandardError: null, lower: null, upper: null },
      ],
      warnings: ['statsmodels no devolvió intervalos de confianza para este forecast.'],
    };

    it('parses a full forecast block inside the ARIMA result', () => {
      const result = normalizeWithArima({ arima: { ...ARIMA_BLOCK, forecast: FORECAST_BLOCK } });
      expect(result.ok).toBe(true);
      expect(result.arima?.forecast?.steps).toBe(2);
      expect(result.arima?.forecast?.confidenceLevel).toBe(0.95);
      expect(result.arima?.forecast?.items[0]).toEqual({
        step: 1, mean: 10.5, meanStandardError: 0.8, lower: 8.9, upper: 12.1,
      });
      expect(result.arima?.forecast?.warnings).toHaveLength(1);
    });

    it('keeps non-finite forecast values as null (serialized by Python) without inventing intervals', () => {
      const result = normalizeWithArima({ arima: { ...ARIMA_BLOCK, forecast: FORECAST_BLOCK } });
      const second = result.arima?.forecast?.items[1];
      expect(second?.mean).toBe(10.7);
      expect(second?.lower).toBeNull();
      expect(second?.upper).toBeNull();
      expect(second?.meanStandardError).toBeNull();
    });

    it('does not throw when the optional forecast/meanStandardError fields are absent', () => {
      const noSe = {
        steps: 1,
        confidenceLevel: 0.95,
        items: [{ step: 1, mean: 5.0, lower: 4.0, upper: 6.0 }],
        warnings: [],
      };
      const result = normalizeWithArima({ arima: { ...ARIMA_BLOCK, forecast: noSe } });
      expect(result.ok).toBe(true);
      expect(result.arima?.forecast?.items[0].meanStandardError).toBeUndefined();

      const noForecast = normalizeWithArima({ arima: ARIMA_BLOCK });
      expect(noForecast.ok).toBe(true);
      expect(noForecast.arima?.forecast).toBeUndefined();
      expect(noForecast.arima?.forecastError).toBeUndefined();
    });

    it('threads forecastError through inside the ARIMA result', () => {
      const result = normalizeWithArima({
        arima: { ...ARIMA_BLOCK, forecastError: 'No se pudo calcular el forecast para este modelo.' },
      });
      expect(result.ok).toBe(true);
      expect(result.arima?.forecastError).toContain('No se pudo calcular el forecast');
    });

    it('rejects a malformed forecast block (bad step)', () => {
      const bad = { ...FORECAST_BLOCK, items: [{ step: 0, mean: 1, lower: 0, upper: 2 }] };
      const result = normalizeWithArima({ arima: { ...ARIMA_BLOCK, forecast: bad } });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('ARIMA inválido');
    });
  });
});
