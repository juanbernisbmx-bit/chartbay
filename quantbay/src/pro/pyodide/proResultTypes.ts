// Tipo de errores estándar del OLS Pro: clásicos (nonrobust) o robustos a
// heterocedasticidad (HC1/HC3 de statsmodels). Los betas no cambian entre modos.
export type ProStandardErrorType = 'classic' | 'HC1' | 'HC3';

export const PRO_STANDARD_ERROR_TYPES: readonly ProStandardErrorType[] = ['classic', 'HC1', 'HC3'];

export const DEFAULT_PRO_STANDARD_ERROR_TYPE: ProStandardErrorType = 'classic';

export const PRO_STANDARD_ERROR_LABELS: Record<ProStandardErrorType, string> = {
  classic: 'errores estándar clásicos',
  HC1: 'errores estándar robustos HC1',
  HC3: 'errores estándar robustos HC3',
};

export function isProStandardErrorType(value: unknown): value is ProStandardErrorType {
  return value === 'classic' || value === 'HC1' || value === 'HC3';
}

export type PyodideOlsCoefficient = {
  name: string;
  estimate: number;
  // null cuando statsmodels no puede calcularlo (ej: ajuste perfecto → t/p indefinidos).
  stdError: number | null;
  tStat: number | null;
  pValue: number | null;
};

export type PyodideOlsResult = {
  ok: boolean;
  engine: 'pyodide';
  // Ausente en payloads previos a HC1/HC3; el runner siempre lo pide explícito.
  standardErrorType?: ProStandardErrorType;
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
};

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

  // seType ausente = payload previo a HC1/HC3 (retrocompatible → undefined);
  // presente pero fuera de {classic, HC1, HC3} = payload corrupto → rechazo.
  let standardErrorType: ProStandardErrorType | undefined;
  if (obj.seType !== undefined && obj.seType !== null) {
    if (!isProStandardErrorType(obj.seType)) {
      return proError('El motor Python devolvió un tipo de errores estándar inválido.');
    }
    standardErrorType = obj.seType;
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
    standardErrorType,
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
  };
}
