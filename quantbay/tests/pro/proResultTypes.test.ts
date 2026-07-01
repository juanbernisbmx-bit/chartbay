import { describe, expect, it } from 'vitest';
import { normalizePyodideOlsResult, proError } from '../../src/pro/pyodide/proResultTypes';

const validPayload = {
  ok: true,
  engine: 'pyodide',
  nobs: 5,
  coefficients: [
    { name: 'Intercept', estimate: 1.0 },
    { name: 'x', estimate: 2.0 },
  ],
  rSquared: 0.999,
  residualStdError: 0.01,
  warnings: [],
};

describe('proError', () => {
  it('builds an ok:false result with the message and pyodide engine', () => {
    const result = proError('algo falló');
    expect(result.ok).toBe(false);
    expect(result.engine).toBe('pyodide');
    expect(result.error).toBe('algo falló');
    expect(result.warnings).toEqual([]);
  });
});

describe('normalizePyodideOlsResult', () => {
  it('parses a valid JSON payload from Python', () => {
    const result = normalizePyodideOlsResult(JSON.stringify(validPayload));
    expect(result.ok).toBe(true);
    expect(result.nobs).toBe(5);
    expect(result.coefficients).toEqual(validPayload.coefficients);
    expect(result.rSquared).toBeCloseTo(0.999);
    expect(result.residualStdError).toBeCloseTo(0.01);
    expect(result.warnings).toEqual([]);
  });

  it('passes through Python-side errors with their message', () => {
    const raw = JSON.stringify({ ok: false, engine: 'pyodide', warnings: [], error: 'Columnas faltantes en el CSV: z.' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Columnas faltantes en el CSV: z.');
  });

  it('keeps warnings from ok:false payloads', () => {
    const raw = JSON.stringify({ ok: false, warnings: ['una advertencia'], error: 'falló' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.warnings).toEqual(['una advertencia']);
  });

  it('rejects non-string payloads', () => {
    const result = normalizePyodideOlsResult(42);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no devolvió resultados');
  });

  it('rejects empty payloads', () => {
    const result = normalizePyodideOlsResult('   ');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no devolvió resultados');
  });

  it('rejects invalid JSON with a clear message', () => {
    const result = normalizePyodideOlsResult('{not json');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON inválido');
  });

  it('rejects non-object JSON', () => {
    const result = normalizePyodideOlsResult('[1,2,3]');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('formato inesperado');
  });

  it('rejects ok:true payloads with missing coefficients', () => {
    const raw = JSON.stringify({ ...validPayload, coefficients: [] });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('coeficientes inválidos');
  });

  it('rejects ok:true payloads with non-finite estimates', () => {
    const raw = JSON.stringify({ ...validPayload, coefficients: [{ name: 'x', estimate: 'NaN' }] });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('coeficientes inválidos');
  });

  it('rejects ok:true payloads with invalid nobs', () => {
    const raw = JSON.stringify({ ...validPayload, nobs: 0 });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('observaciones inválido');
  });

  it('accepts null rSquared (constant Y) as undefined', () => {
    const raw = JSON.stringify({ ...validPayload, rSquared: null });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.rSquared).toBeUndefined();
  });

  it('uses a fallback message when ok:false has no error text', () => {
    const raw = JSON.stringify({ ok: false });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error desconocido en el motor Python.');
  });
});
