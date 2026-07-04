import { describe, expect, it } from 'vitest';
import {
  MIN_PRO_TS_OBSERVATIONS,
  validateProArimaOrder,
  validateProTimeSeriesInput,
} from '../../src/pro/pyodide/proTimeSeriesValidation';

// Non-constant, finite series of length n.
function makeSeries(n: number): number[] {
  return Array.from({ length: n }, (_, i) => Math.sin(i * 0.7) + i * 0.13);
}

function expectOk(result: ReturnType<typeof validateProTimeSeriesInput>) {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

describe('validateProTimeSeriesInput', () => {
  it('accepts a long, varied series and defaults maxLag=12, ljungBoxLags=1..12, adf=c', () => {
    const value = expectOk(validateProTimeSeriesInput({ values: makeSeries(40), variableName: 'serie' }));
    expect(value.maxLag).toBe(12);
    expect(value.ljungBoxLags).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(value.adfRegression).toBe('c');
    expect(value.warnings).toEqual([]);
    expect(value.values).toHaveLength(40);
  });

  it('drops non-numeric / missing / infinite values and warns about it', () => {
    const values = [...makeSeries(20), NaN, Infinity, -Infinity];
    const value = expectOk(validateProTimeSeriesInput({ values, variableName: 'serie' }));
    expect(value.values).toHaveLength(20);
    expect(value.warnings.some(w => w.includes('Se descartaron 3'))).toBe(true);
  });

  it('blocks a series with too few valid observations', () => {
    const result = validateProTimeSeriesInput({ values: makeSeries(5), variableName: 'serie' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('suficientes observaciones válidas');
      expect(result.error).toContain(String(MIN_PRO_TS_OBSERVATIONS));
    }
  });

  it('blocks a constant series (ADF/ACF/PACF undefined)', () => {
    const result = validateProTimeSeriesInput({ values: Array(20).fill(3.5), variableName: 'serie' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('constante');
  });

  it('caps a too-high maxLag to a reasonable bound and warns', () => {
    // n=40 → safe upper bound = floor(40/2) - 1 = 19.
    const value = expectOk(validateProTimeSeriesInput({ values: makeSeries(40), variableName: 'serie', maxLag: 100 }));
    expect(value.maxLag).toBe(19);
    expect(value.warnings.some(w => w.includes('demasiado alto'))).toBe(true);
  });

  it('raises a maxLag below 1 to 1 with a warning', () => {
    const value = expectOk(validateProTimeSeriesInput({ values: makeSeries(40), variableName: 'serie', maxLag: 0 }));
    expect(value.maxLag).toBe(1);
    expect(value.ljungBoxLags).toEqual([1]);
    expect(value.warnings.some(w => w.includes('al menos 1'))).toBe(true);
  });

  it('keeps only Ljung-Box lags within 1..maxLag when explicit lags are given', () => {
    const value = expectOk(
      validateProTimeSeriesInput({ values: makeSeries(40), variableName: 'serie', maxLag: 10, ljungBoxLags: [2, 5, 50, -3] })
    );
    expect(value.ljungBoxLags).toEqual([2, 5]);
    expect(value.warnings.some(w => w.includes('rezagos de Ljung-Box'))).toBe(true);
  });

  it('falls back to 1..maxLag when every explicit Ljung-Box lag is invalid', () => {
    const value = expectOk(
      validateProTimeSeriesInput({ values: makeSeries(40), variableName: 'serie', maxLag: 4, ljungBoxLags: [99, 100] })
    );
    expect(value.ljungBoxLags).toEqual([1, 2, 3, 4]);
  });

  it('rejects an invalid ADF regression term', () => {
    const result = validateProTimeSeriesInput({
      values: makeSeries(40),
      variableName: 'serie',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adfRegression: 'bogus' as any,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('regresión ADF inválido');
  });

  it('requires a variable name', () => {
    const result = validateProTimeSeriesInput({ values: makeSeries(40), variableName: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('columna de serie');
  });
});

describe('validateProArimaOrder', () => {
  const N = 40;

  it('accepts a valid non-negative integer order', () => {
    const result = validateProArimaOrder({ p: 1, d: 1, q: 1 }, N);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ p: 1, d: 1, q: 1 });
  });

  it('rejects negative parameters', () => {
    const result = validateProArimaOrder({ p: -1, d: 0, q: 1 }, N);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('enteros no negativos');
  });

  it('rejects non-integer parameters', () => {
    const result = validateProArimaOrder({ p: 1.5, d: 0, q: 1 }, N);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('enteros no negativos');
  });

  it('rejects ARIMA(0,0,0) (no temporal dynamics)', () => {
    const result = validateProArimaOrder({ p: 0, d: 0, q: 0 }, N);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ARIMA(0,0,0)');
  });

  it('rejects p or q above the first-version limit (5)', () => {
    expect(validateProArimaOrder({ p: 6, d: 0, q: 1 }, N).ok).toBe(false);
    const result = validateProArimaOrder({ p: 1, d: 0, q: 6 }, N);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('p y q entre 0 y 5');
  });

  it('rejects d above the first-version limit (2)', () => {
    const result = validateProArimaOrder({ p: 1, d: 3, q: 1 }, N);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('d entre 0 y 2');
  });

  it('rejects an order that needs more observations than the (differenced) series has', () => {
    // n=12, d=2 → 10 usable; p+q+2 = 5+5+2 = 12 > 10.
    const result = validateProArimaOrder({ p: 5, d: 2, q: 5 }, 12);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('suficientes observaciones');
  });

  it('rejects a missing order', () => {
    const result = validateProArimaOrder(undefined, N);
    expect(result.ok).toBe(false);
  });
});
