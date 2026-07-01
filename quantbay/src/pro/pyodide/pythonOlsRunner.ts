import { getPyodide } from './pyodideLoader';
import { normalizePyodideOlsResult, proError, type PyodideOlsResult } from './proResultTypes';

export type PyodideOlsPhase = 'loading-pyodide' | 'loading-packages' | 'running';

// OLS con statsmodels.api.OLS — Fase 1 del Pro MVP. Solo lin-lin con intercepto
// automático: nada de robustos, RLS, formas funcionales ni dummies todavía.
// Validation errors are returned as {ok: false, error} dicts (never raised) so
// the TS side always receives a parseable JSON payload. Non-finite statistics
// (perfect fit, constant Y) are serialized as null because JSON.parse rejects
// NaN/Infinity literals.
const PYTHON_OLS_SCRIPT = `
import io
import json
import math

import numpy as np
import pandas as pd
import statsmodels.api as sm


def _chartbay_pro_ols():
    def fail(message):
        return {"ok": False, "engine": "pyodide", "warnings": [], "error": message}

    def finite_or_none(value):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return None
        return value if math.isfinite(value) else None

    y_name = chartbay_y_name
    x_names = json.loads(chartbay_x_names_json)

    try:
        df = pd.read_csv(io.StringIO(chartbay_csv_text))
    except Exception as exc:
        return fail("CSV inválido: no se pudo leer el archivo (" + str(exc) + ").")

    missing = [c for c in [y_name] + x_names if c not in df.columns]
    if missing:
        return fail("Columnas faltantes en el CSV: " + ", ".join(missing) + ".")

    if len(df) == 0:
        return fail("El CSV no tiene filas de datos.")

    warnings = []
    numeric = {}
    for col in [y_name] + x_names:
        converted = pd.to_numeric(df[col], errors="coerce")
        if converted.notna().sum() == 0:
            kind = "Y" if col == y_name else "X"
            return fail("La columna " + kind + ' "' + col + '" no contiene valores numéricos.')
        numeric[col] = converted

    # ±inf cuenta como valor inválido igual que NaN: se descarta la fila entera.
    data = pd.DataFrame(numeric).replace([np.inf, -np.inf], np.nan).dropna()
    n_dropped = len(df) - len(data)
    if n_dropped > 0:
        warnings.append(
            "Se descartaron " + str(n_dropped)
            + " filas con valores faltantes, no numéricos o infinitos."
        )

    n_params = len(x_names) + 1
    if len(data) < n_params + 1:
        return fail(
            "Observaciones insuficientes: hay " + str(len(data))
            + " filas válidas y el modelo necesita al menos " + str(n_params + 1) + "."
        )

    y = data[y_name].to_numpy(dtype=float)
    X = sm.add_constant(data[x_names].to_numpy(dtype=float), has_constant="add")

    if np.linalg.matrix_rank(X) < X.shape[1]:
        return fail(
            "Matriz de diseño singular o con rango deficiente: "
            "hay variables X constantes o perfectamente colineales."
        )

    try:
        results = sm.OLS(y, X).fit()
    except Exception as exc:
        return fail("statsmodels no pudo estimar el modelo OLS: " + str(exc) + ".")

    names = ["Intercept"] + x_names
    coefficients = []
    for i in range(len(names)):
        estimate = finite_or_none(results.params[i])
        if estimate is None:
            return fail(
                "statsmodels devolvió un coeficiente no finito para \\"" + names[i]
                + "\\": el modelo no es estimable con estos datos."
            )
        coefficients.append({
            "name": names[i],
            "estimate": estimate,
            "stdError": finite_or_none(results.bse[i]),
            "tStat": finite_or_none(results.tvalues[i]),
            "pValue": finite_or_none(results.pvalues[i]),
        })

    residuals = [finite_or_none(v) for v in results.resid]
    fitted = [finite_or_none(v) for v in results.fittedvalues]
    if any(v is None for v in residuals) or any(v is None for v in fitted):
        return fail("statsmodels devolvió residuos o valores ajustados no finitos.")

    scale = finite_or_none(results.scale)
    residual_std_error = math.sqrt(scale) if scale is not None and scale >= 0 else None
    if residual_std_error is None:
        return fail("statsmodels devolvió una varianza residual no finita.")

    r_squared = finite_or_none(results.rsquared)
    f_stat = finite_or_none(results.fvalue)
    f_pvalue = finite_or_none(results.f_pvalue)
    # Con Y casi constante, la TSS centrada es ~0 y el F-stat de statsmodels
    # puede dar un número finito pero sin sentido (incluso negativo), ya que
    # es un cociente de sumas de cuadrados y nunca puede ser < 0. Si R² no
    # está definido o el F-stat es negativo, ambos se anulan como el R².
    if r_squared is None or (f_stat is not None and f_stat < 0):
        f_stat = None
        f_pvalue = None

    return {
        "ok": True,
        "engine": "pyodide",
        "nobs": int(results.nobs),
        "coefficients": coefficients,
        "rSquared": r_squared,
        "rSquaredAdj": finite_or_none(results.rsquared_adj),
        "fStat": f_stat,
        "fPValue": f_pvalue,
        "dfResid": int(results.df_resid),
        "residualStdError": residual_std_error,
        "residuals": residuals,
        "fitted": fitted,
        "warnings": warnings,
    }


json.dumps(_chartbay_pro_ols())
`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs an OLS regression with statsmodels in Python (Pyodide) in the browser.
 * Never throws — every failure mode is returned as {ok: false, error}.
 */
export async function runPyodideOls(
  args: { csvText: string; yName: string; xNames: string[] },
  onPhase?: (phase: PyodideOlsPhase) => void
): Promise<PyodideOlsResult> {
  if (!args.csvText || args.csvText.trim() === '') {
    return proError('No hay CSV cargado para ejecutar en ChartBay Pro.');
  }
  if (!args.yName) {
    return proError('Seleccioná una variable Y antes de ejecutar.');
  }
  if (args.xNames.length === 0) {
    return proError('Seleccioná al menos una variable X antes de ejecutar.');
  }

  let pyodide;
  try {
    onPhase?.('loading-pyodide');
    pyodide = await getPyodide();
  } catch (err) {
    return proError(`No se pudo cargar Pyodide (Python en el navegador): ${errorMessage(err)}`);
  }

  try {
    onPhase?.('loading-packages');
    await pyodide.loadPackage(['numpy', 'pandas', 'statsmodels']);
  } catch (err) {
    return proError(`No se pudieron cargar numpy/pandas/statsmodels en el navegador: ${errorMessage(err)}`);
  }

  try {
    onPhase?.('running');
    pyodide.globals.set('chartbay_csv_text', args.csvText);
    pyodide.globals.set('chartbay_y_name', args.yName);
    pyodide.globals.set('chartbay_x_names_json', JSON.stringify(args.xNames));
    const raw = await pyodide.runPythonAsync(PYTHON_OLS_SCRIPT);
    return normalizePyodideOlsResult(raw);
  } catch (err) {
    return proError(`Error ejecutando OLS con statsmodels en Python: ${errorMessage(err)}`);
  }
}
