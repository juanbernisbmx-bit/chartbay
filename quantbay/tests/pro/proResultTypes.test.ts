import { describe, expect, it } from 'vitest';
import { normalizePyodideOlsResult, proError } from '../../src/pro/pyodide/proResultTypes';

const validPayload = {
  ok: true,
  engine: 'pyodide',
  functionalForm: 'lin-lin',
  yName: 'y',
  xNames: ['x'],
  nobs: 5,
  coefficients: [
    { name: 'Intercept', estimate: 1.0, stdError: 0.1, tStat: 10.0, pValue: 0.001 },
    { name: 'x', estimate: 2.0, stdError: 0.05, tStat: 40.0, pValue: 0.0001 },
  ],
  rSquared: 0.999,
  rSquaredAdj: 0.998,
  fStat: 1600.0,
  fPValue: 0.0001,
  dfResid: 3,
  residualStdError: 0.01,
  residuals: [0.01, -0.01, 0.0, 0.01, -0.01],
  fitted: [3.0, 5.0, 7.0, 9.0, 11.0],
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
  it('parses a valid statsmodels JSON payload from Python', () => {
    const result = normalizePyodideOlsResult(JSON.stringify(validPayload));
    expect(result.ok).toBe(true);
    expect(result.functionalForm).toBe('lin-lin');
    expect(result.yName).toBe('y');
    expect(result.xNames).toEqual(['x']);
    expect(result.nobs).toBe(5);
    expect(result.coefficients).toEqual(validPayload.coefficients);
    expect(result.rSquared).toBeCloseTo(0.999);
    expect(result.rSquaredAdj).toBeCloseTo(0.998);
    expect(result.fStat).toBeCloseTo(1600.0);
    expect(result.fPValue).toBeCloseTo(0.0001);
    expect(result.dfResid).toBe(3);
    expect(result.residualStdError).toBeCloseTo(0.01);
    expect(result.residuals).toEqual(validPayload.residuals);
    expect(result.fitted).toEqual(validPayload.fitted);
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

  it('rejects coefficients missing the stdError/tStat/pValue fields', () => {
    const raw = JSON.stringify({ ...validPayload, coefficients: [{ name: 'x', estimate: 2.0 }] });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('coeficientes inválidos');
  });

  it('rejects ok:true payloads with non-finite estimates', () => {
    const raw = JSON.stringify({
      ...validPayload,
      coefficients: [{ name: 'x', estimate: 'NaN', stdError: 0.1, tStat: 1.0, pValue: 0.5 }],
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('coeficientes inválidos');
  });

  it('rejects non-finite stdError values (NaN serialized as string)', () => {
    const raw = JSON.stringify({
      ...validPayload,
      coefficients: [{ name: 'x', estimate: 2.0, stdError: 'Infinity', tStat: 1.0, pValue: 0.5 }],
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('coeficientes inválidos');
  });

  it('accepts null stdError/tStat/pValue (perfect fit) as null', () => {
    const raw = JSON.stringify({
      ...validPayload,
      coefficients: [
        { name: 'Intercept', estimate: 1.0, stdError: 0.0, tStat: null, pValue: null },
        { name: 'x', estimate: 2.0, stdError: 0.0, tStat: null, pValue: null },
      ],
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.coefficients?.[0].tStat).toBeNull();
    expect(result.coefficients?.[0].pValue).toBeNull();
  });

  it('rejects ok:true payloads with invalid nobs', () => {
    const raw = JSON.stringify({ ...validPayload, nobs: 0 });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('observaciones inválido');
  });

  it('rejects ok:true payloads with missing dfResid', () => {
    const { dfResid: _dfResid, ...rest } = validPayload;
    const result = normalizePyodideOlsResult(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('grados de libertad');
  });

  it('rejects residuals whose length does not match nobs', () => {
    const raw = JSON.stringify({ ...validPayload, residuals: [0.1, 0.2] });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('residuos inválidos');
  });

  it('rejects fitted values with non-finite entries', () => {
    const raw = JSON.stringify({ ...validPayload, fitted: [3.0, 5.0, 7.0, 9.0, null] });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('valores ajustados inválidos');
  });

  it('rejects missing residuals', () => {
    const { residuals: _residuals, ...rest } = validPayload;
    const result = normalizePyodideOlsResult(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('residuos inválidos');
  });

  it('accepts null rSquared and fStat (constant Y / perfect fit) as undefined', () => {
    const raw = JSON.stringify({ ...validPayload, rSquared: null, rSquaredAdj: null, fStat: null, fPValue: null });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.rSquared).toBeUndefined();
    expect(result.rSquaredAdj).toBeUndefined();
    expect(result.fStat).toBeUndefined();
    expect(result.fPValue).toBeUndefined();
  });

  it('rejects non-numeric rSquared values', () => {
    const raw = JSON.stringify({ ...validPayload, rSquared: 'alto' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('R² inválido');
  });

  it('nulls out a negative F-stat instead of trusting it (never valid: F is a ratio of sums of squares)', () => {
    const raw = JSON.stringify({ ...validPayload, fStat: -4.0, fPValue: 1.0 });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.fStat).toBeUndefined();
    expect(result.fPValue).toBeUndefined();
  });

  it('acepta un payload robusto HC1 válido y expone standardErrorType', () => {
    const raw = JSON.stringify({
      ...validPayload,
      seType: 'HC1',
      coefficients: [
        { name: 'Intercept', estimate: 1.0, stdError: 0.15, tStat: 6.7, pValue: 0.006 },
        { name: 'x', estimate: 2.0, stdError: 0.08, tStat: 25.0, pValue: 0.0002 },
      ],
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.standardErrorType).toBe('HC1');
    // Los betas son los mismos que en classic; solo cambia la inferencia.
    expect(result.coefficients?.map(c => c.estimate)).toEqual([1.0, 2.0]);
  });

  it('acepta un payload robusto HC3 válido y expone standardErrorType', () => {
    const raw = JSON.stringify({ ...validPayload, seType: 'HC3' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.standardErrorType).toBe('HC3');
  });

  it('acepta un payload classic y expone standardErrorType classic', () => {
    const raw = JSON.stringify({ ...validPayload, seType: 'classic' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.standardErrorType).toBe('classic');
  });

  it('deja standardErrorType undefined cuando el payload no lo trae (retrocompatibilidad)', () => {
    const result = normalizePyodideOlsResult(JSON.stringify(validPayload));
    expect(result.ok).toBe(true);
    expect(result.standardErrorType).toBeUndefined();
  });

  it('rechaza un seType fuera de classic/HC1/HC3', () => {
    const raw = JSON.stringify({ ...validPayload, seType: 'HC7' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('tipo de errores estándar inválido');
  });

  it('acepta null en stdError/tStat/pValue de resultados robustos (no finito → null)', () => {
    const raw = JSON.stringify({
      ...validPayload,
      seType: 'HC3',
      coefficients: [
        { name: 'Intercept', estimate: 1.0, stdError: null, tStat: null, pValue: null },
        { name: 'x', estimate: 2.0, stdError: null, tStat: null, pValue: null },
      ],
      fStat: null,
      fPValue: null,
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.coefficients?.[0].stdError).toBeNull();
    expect(result.fStat).toBeUndefined();
  });

  it('rechaza no finitos serializados como string en resultados robustos', () => {
    const raw = JSON.stringify({
      ...validPayload,
      seType: 'HC1',
      coefficients: [{ name: 'x', estimate: 2.0, stdError: 'NaN', tStat: 1.0, pValue: 0.5 }],
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('coeficientes inválidos');
  });

  it('uses a fallback message when ok:false has no error text', () => {
    const raw = JSON.stringify({ ok: false });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Error desconocido en el motor Python.');
  });

  it('leaves rlsTest undefined when Python reports null (no restriction was evaluated)', () => {
    const raw = JSON.stringify({ ...validPayload, rlsTest: null });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.rlsTest).toBeUndefined();
  });

  it('leaves rlsTest undefined when Python omits the field entirely', () => {
    const result = normalizePyodideOlsResult(JSON.stringify(validPayload));
    expect(result.ok).toBe(true);
    expect(result.rlsTest).toBeUndefined();
  });

  it('parses a well-formed rlsTest (Wald/F test on the unrestricted fit)', () => {
    const raw = JSON.stringify({
      ...validPayload,
      rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true },
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.rlsTest).toEqual({ label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true });
  });

  it('accepts a null fStat/fPValue in rlsTest (statsmodels degenerate case)', () => {
    const raw = JSON.stringify({
      ...validPayload,
      rlsTest: { label: 'beta1 = 0', fStat: null, fPValue: null, dfNum: 1, dfDenom: 3, reject: false },
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.rlsTest?.fStat).toBeNull();
    expect(result.rlsTest?.fPValue).toBeNull();
  });

  it('rejects a malformed rlsTest (missing label)', () => {
    const raw = JSON.stringify({
      ...validPayload,
      rlsTest: { fStat: 1, fPValue: 0.5, dfNum: 1, dfDenom: 3, reject: false },
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('restricción RLS inválido');
  });

  it('rejects a malformed rlsTest (reject is not a boolean)', () => {
    const raw = JSON.stringify({
      ...validPayload,
      rlsTest: { label: 'beta1 = 0', fStat: 1, fPValue: 0.5, dfNum: 1, dfDenom: 3, reject: 'yes' },
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('restricción RLS inválido');
  });

  it('rejects a non-object rlsTest', () => {
    const raw = JSON.stringify({ ...validPayload, rlsTest: 'beta1 = 0' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('restricción RLS inválido');
  });

  it('accepts each of the 4 functional forms', () => {
    for (const form of ['lin-lin', 'log-lin', 'lin-log', 'log-log']) {
      const raw = JSON.stringify({ ...validPayload, functionalForm: form });
      const result = normalizePyodideOlsResult(raw);
      expect(result.ok).toBe(true);
      expect(result.functionalForm).toBe(form);
    }
  });

  it('rejects missing functionalForm', () => {
    const { functionalForm: _functionalForm, ...rest } = validPayload;
    const result = normalizePyodideOlsResult(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('forma funcional inválida');
  });

  it('rejects an unknown functionalForm value', () => {
    const raw = JSON.stringify({ ...validPayload, functionalForm: 'quadratic' });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('forma funcional inválida');
  });

  it('rejects missing yName', () => {
    const { yName: _yName, ...rest } = validPayload;
    const result = normalizePyodideOlsResult(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nombre de Y inválido');
  });

  it('rejects missing or empty xNames', () => {
    const raw = JSON.stringify({ ...validPayload, xNames: [] });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('nombres de X inválidos');
  });

  it('carries the transformed (ln-prefixed) yName/xNames through for log forms', () => {
    const raw = JSON.stringify({
      ...validPayload,
      functionalForm: 'log-log',
      yName: 'ln(y)',
      xNames: ['ln(x)'],
      coefficients: [
        { name: 'Intercept', estimate: 1.0, stdError: 0.1, tStat: 10.0, pValue: 0.001 },
        { name: 'ln(x)', estimate: 2.0, stdError: 0.05, tStat: 40.0, pValue: 0.0001 },
      ],
    });
    const result = normalizePyodideOlsResult(raw);
    expect(result.ok).toBe(true);
    expect(result.yName).toBe('ln(y)');
    expect(result.xNames).toEqual(['ln(x)']);
    expect(result.coefficients?.[1].name).toBe('ln(x)');
  });
});
