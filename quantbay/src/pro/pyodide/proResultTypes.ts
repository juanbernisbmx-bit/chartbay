import type { FunctionalForm } from '../../functionalForms';

export type PyodideOlsCoefficient = {
  name: string;
  estimate: number;
  // null cuando statsmodels no puede calcularlo (ej: ajuste perfecto → t/p indefinidos).
  stdError: number | null;
  tStat: number | null;
  pValue: number | null;
};

// Wald/F test of a linear restriction (Rβ = q) against the UNRESTRICTED OLS
// fit above (statsmodels results.f_test). This does NOT re-estimate β under
// the restriction — see the note in pro/pyodide/pythonOlsRunner.ts for why
// that's a deliberate difference from Lite's true restricted estimator.
export type PyodideRlsTest = {
  label: string;
  fStat: number | null;
  fPValue: number | null;
  dfNum: number | null;
  dfDenom: number | null;
  reject: boolean;
};

export type PyodideOlsResult = {
  ok: boolean;
  engine: 'pyodide';
  // Forma funcional efectivamente estimada por Python. Sólo presente en
  // resultados ok:true (ver normalizePyodideOlsResult).
  functionalForm?: FunctionalForm;
  yName?: string;
  xNames?: string[];
  nobs?: number;
  coefficients?: PyodideOlsCoefficient[];
  rSquared?: number;
  rSquaredAdj?: number;
  fStat?: number;
  fPValue?: number;
  dfResid?: number;
  residualStdError?: number;
  residuals?: number[];
  fitted?: number[];
  warnings: string[];
  error?: string;
  // Only present when a valid RLS constraint was passed in for this run.
  rlsTest?: PyodideRlsTest;
};

const VALID_FUNCTIONAL_FORMS: ReadonlySet<string> = new Set(['lin-lin', 'log-lin', 'lin-log', 'log-log']);

export function proError(message: string): PyodideOlsResult {
  return { ok: false, engine: 'pyodide', warnings: [], error: message };
}

// Statsmodels devuelve NaN/inf en casos degenerados (ajuste perfecto, Y constante);
// el script Python los serializa como null y acá se aceptan solo null o finito.
function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function parseCoefficients(raw: unknown): PyodideOlsCoefficient[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const coefficients: PyodideOlsCoefficient[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const { name, estimate } = record;
    if (typeof name !== 'string' || typeof estimate !== 'number' || !Number.isFinite(estimate)) return null;
    if (!('stdError' in record) || !('tStat' in record) || !('pValue' in record)) return null;
    const stdError = finiteOrNull(record.stdError);
    const tStat = finiteOrNull(record.tStat);
    const pValue = finiteOrNull(record.pValue);
    if (stdError === undefined || tStat === undefined || pValue === undefined) return null;
    coefficients.push({ name, estimate, stdError, tStat, pValue });
  }
  return coefficients;
}

// null/undefined means "no restriction was evaluated" (the common case for a
// plain OLS run) — that's valid and yields rlsTest: undefined, not an error.
// Anything else must be a well-formed object, or the whole payload is rejected
// (a malformed RLS test is just as untrustworthy as malformed coefficients).
function parseRlsTest(raw: unknown): { ok: true; value: PyodideRlsTest | undefined } | { ok: false } {
  if (raw === null || raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };

  const record = raw as Record<string, unknown>;
  if (typeof record.label !== 'string' || record.label.trim() === '') return { ok: false };

  const fStat = finiteOrNull(record.fStat);
  const fPValue = finiteOrNull(record.fPValue);
  if (fStat === undefined || fPValue === undefined) return { ok: false };

  const dfNum = finiteOrNull(record.dfNum);
  const dfDenom = finiteOrNull(record.dfDenom);
  if (dfNum === undefined || dfDenom === undefined) return { ok: false };

  if (typeof record.reject !== 'boolean') return { ok: false };

  return {
    ok: true,
    value: { label: record.label, fStat, fPValue, dfNum, dfDenom, reject: record.reject },
  };
}

function parseFiniteArray(raw: unknown, expectedLength: number): number[] | null {
  if (!Array.isArray(raw) || raw.length !== expectedLength) return null;
  for (const value of raw) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  }
  return raw as number[];
}

/**
 * Converts the raw value returned by pyodide.runPythonAsync (expected: a JSON
 * string produced by the Python statsmodels OLS script) into a validated
 * PyodideOlsResult. Never throws — malformed payloads become ok:false results
 * with a clear message.
 */
export function normalizePyodideOlsResult(raw: unknown): PyodideOlsResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return proError('El motor Python no devolvió resultados.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return proError('El motor Python devolvió un resultado ilegible (JSON inválido).');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return proError('El motor Python devolvió un resultado con formato inesperado.');
  }

  const obj = parsed as Record<string, unknown>;
  const warnings = Array.isArray(obj.warnings)
    ? obj.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  if (obj.ok !== true) {
    const error = typeof obj.error === 'string' && obj.error.trim() !== ''
      ? obj.error
      : 'Error desconocido en el motor Python.';
    return { ok: false, engine: 'pyodide', warnings, error };
  }

  if (typeof obj.functionalForm !== 'string' || !VALID_FUNCTIONAL_FORMS.has(obj.functionalForm)) {
    return proError('El motor Python devolvió una forma funcional inválida.');
  }
  const functionalForm = obj.functionalForm as FunctionalForm;
  if (typeof obj.yName !== 'string' || obj.yName.trim() === '') {
    return proError('El motor Python devolvió un nombre de Y inválido.');
  }
  if (!Array.isArray(obj.xNames) || obj.xNames.length === 0 || !obj.xNames.every((n): n is string => typeof n === 'string')) {
    return proError('El motor Python devolvió nombres de X inválidos.');
  }

  const coefficients = parseCoefficients(obj.coefficients);
  if (!coefficients) {
    return proError('El motor Python devolvió coeficientes inválidos.');
  }
  if (typeof obj.nobs !== 'number' || !Number.isFinite(obj.nobs) || obj.nobs <= 0) {
    return proError('El motor Python devolvió un número de observaciones inválido.');
  }
  if (typeof obj.dfResid !== 'number' || !Number.isFinite(obj.dfResid) || obj.dfResid < 1) {
    return proError('El motor Python devolvió grados de libertad inválidos.');
  }
  if (typeof obj.residualStdError !== 'number' || !Number.isFinite(obj.residualStdError)) {
    return proError('El motor Python devolvió un error estándar residual inválido.');
  }
  const residuals = parseFiniteArray(obj.residuals, obj.nobs);
  if (!residuals) {
    return proError('El motor Python devolvió residuos inválidos.');
  }
  const fitted = parseFiniteArray(obj.fitted, obj.nobs);
  if (!fitted) {
    return proError('El motor Python devolvió valores ajustados inválidos.');
  }

  const rlsTestParsed = parseRlsTest(obj.rlsTest);
  if (!rlsTestParsed.ok) {
    return proError('El motor Python devolvió un test de restricción RLS inválido.');
  }

  // R², R² ajustado, F y su p-value pueden ser legítimamente null
  // (Y constante o ajuste perfecto); null → undefined, cualquier otra cosa se rechaza.
  const rSquared = finiteOrNull(obj.rSquared);
  const rSquaredAdj = finiteOrNull(obj.rSquaredAdj);
  let fStat = finiteOrNull(obj.fStat);
  let fPValue = finiteOrNull(obj.fPValue);
  if (rSquared === undefined && obj.rSquared !== undefined) {
    return proError('El motor Python devolvió un R² inválido.');
  }
  if (rSquaredAdj === undefined && obj.rSquaredAdj !== undefined) {
    return proError('El motor Python devolvió un R² ajustado inválido.');
  }
  if (fStat === undefined && obj.fStat !== undefined) {
    return proError('El motor Python devolvió un F-stat inválido.');
  }
  if (fPValue === undefined && obj.fPValue !== undefined) {
    return proError('El motor Python devolvió un p-value del F-stat inválido.');
  }
  // F-stat es un cociente de sumas de cuadrados: nunca puede ser negativo. Python
  // ya anula ambos en el caso degenerado (Y ~constante), pero no confiamos
  // ciegamente en eso: si igual llega un F-stat negativo, se anula acá también.
  if (typeof fStat === 'number' && fStat < 0) {
    fStat = null;
    fPValue = null;
  }

  return {
    ok: true,
    engine: 'pyodide',
    functionalForm,
    yName: obj.yName,
    xNames: obj.xNames,
    nobs: obj.nobs,
    coefficients,
    rSquared: rSquared ?? undefined,
    rSquaredAdj: rSquaredAdj ?? undefined,
    fStat: fStat ?? undefined,
    fPValue: fPValue ?? undefined,
    dfResid: obj.dfResid,
    residualStdError: obj.residualStdError,
    residuals,
    fitted,
    warnings,
    rlsTest: rlsTestParsed.value,
  };
}
