export type PyodideOlsCoefficient = {
  name: string;
  estimate: number;
};

export type PyodideOlsResult = {
  ok: boolean;
  engine: 'pyodide';
  nobs?: number;
  coefficients?: PyodideOlsCoefficient[];
  rSquared?: number;
  residualStdError?: number;
  warnings: string[];
  error?: string;
};

export function proError(message: string): PyodideOlsResult {
  return { ok: false, engine: 'pyodide', warnings: [], error: message };
}

function parseCoefficients(raw: unknown): PyodideOlsCoefficient[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const coefficients: PyodideOlsCoefficient[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') return null;
    const { name, estimate } = item as Record<string, unknown>;
    if (typeof name !== 'string' || typeof estimate !== 'number' || !Number.isFinite(estimate)) return null;
    coefficients.push({ name, estimate });
  }
  return coefficients;
}

/**
 * Converts the raw value returned by pyodide.runPythonAsync (expected: a JSON
 * string produced by the Python OLS script) into a validated PyodideOlsResult.
 * Never throws — malformed payloads become ok:false results with a clear message.
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

  const coefficients = parseCoefficients(obj.coefficients);
  if (!coefficients) {
    return proError('El motor Python devolvió coeficientes inválidos.');
  }
  if (typeof obj.nobs !== 'number' || !Number.isFinite(obj.nobs) || obj.nobs <= 0) {
    return proError('El motor Python devolvió un número de observaciones inválido.');
  }
  if (typeof obj.residualStdError !== 'number' || !Number.isFinite(obj.residualStdError)) {
    return proError('El motor Python devolvió un error estándar residual inválido.');
  }
  // rSquared may legitimately be null (TSS = 0, i.e. constant Y).
  const rSquared = typeof obj.rSquared === 'number' && Number.isFinite(obj.rSquared) ? obj.rSquared : undefined;

  return {
    ok: true,
    engine: 'pyodide',
    nobs: obj.nobs,
    coefficients,
    rSquared,
    residualStdError: obj.residualStdError,
    warnings,
  };
}
