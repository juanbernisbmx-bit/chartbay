import { getPyodide } from './pyodideLoader';
import {
  DEFAULT_PRO_STANDARD_ERROR_TYPE,
  PRO_STANDARD_ERROR_TYPES,
  isProStandardErrorType,
  normalizePyodideOlsResult,
  proError,
  type PyodideOlsResult,
} from './proResultTypes';
import type { FunctionalForm } from '../../functionalForms';
import type { RLSConstraint } from '../../rls';

export type PyodideOlsPhase = 'loading-pyodide' | 'loading-packages' | 'running';

// OLS con statsmodels.api.OLS — con las 4 formas funcionales (lin-lin,
// log-lin, lin-log, log-log), errores estándar clásicos o robustos HC1/HC3
// (cov_type de statsmodels) y test de restricciones lineales (Rβ = q) vía
// statsmodels' f_test. IMPORTANTE: el modelo estimado y devuelto (coeficientes,
// residuos, R², etc.) es SIEMPRE el OLS no restringido — la restricción no
// re-estima los coeficientes, sólo evalúa (Wald/F) si es compatible con los
// datos. Esto es intencional: es lo que statsmodels ofrece de forma nativa y
// evita reimplementar la álgebra de mínimos cuadrados restringidos en Python.
// Lite, en cambio, sí re-estima β bajo la restricción (ver rls.ts) — por eso
// nunca se comparan los coeficientes de Lite-RLS contra los de Pro; sólo se
// compara el test de restricción en sí (ver pro/liteComparison.ts).
// Todavía sin dummies categóricas (ver pro/proCapability.ts, que bloquea esa
// selección antes de llegar acá).
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
    form = chartbay_functional_form
    log_y = form in ("log-lin", "log-log")
    log_x = form in ("lin-log", "log-log")
    se_type = chartbay_se_type

    # El lado TS ya valida esto antes de ejecutar Python; se repite acá para que
    # un valor corrupto nunca llegue a statsmodels como cov_type arbitrario.
    if se_type not in ("classic", "HC1", "HC3"):
        return fail('Tipo de errores estándar no soportado: "' + str(se_type) + '". Usá classic, HC1 o HC3.')

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
    data = pd.DataFrame(numeric).replace([np.inf, -np.inf], np.nan).dropna().reset_index(drop=True)
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

    # El dominio se valida sobre los datos ya limpios (mismo criterio que Lite:
    # quantbay/src/functionalForms.ts), nunca se corre log() sobre un valor <= 0.
    def first_non_positive_index(series):
        invalid = series.index[series <= 0]
        return int(invalid[0]) if len(invalid) > 0 else None

    if log_y:
        bad_row = first_non_positive_index(data[y_name])
        if bad_row is not None:
            return fail(
                'La variable Y "' + y_name + '" tiene un valor <= 0 en la fila ' + str(bad_row)
                + " (valor: " + str(data[y_name].iloc[bad_row]) + "). "
                "El logaritmo natural no está definido para valores no positivos."
            )
        y_series = np.log(data[y_name])
        y_label = "ln(" + y_name + ")"
    else:
        y_series = data[y_name]
        y_label = y_name

    x_labels = []
    x_columns = []
    for col in x_names:
        if log_x:
            bad_row = first_non_positive_index(data[col])
            if bad_row is not None:
                return fail(
                    'La variable X "' + col + '" tiene un valor <= 0 en la fila ' + str(bad_row)
                    + " (valor: " + str(data[col].iloc[bad_row]) + "). "
                    "El logaritmo natural no está definido para valores no positivos."
                )
            x_columns.append(np.log(data[col]))
            x_labels.append("ln(" + col + ")")
        else:
            x_columns.append(data[col])
            x_labels.append(col)

    y = y_series.to_numpy(dtype=float)
    if x_columns:
        X_raw = np.column_stack([c.to_numpy(dtype=float) for c in x_columns])
    else:
        X_raw = np.empty((len(data), 0))
    X = sm.add_constant(X_raw, has_constant="add")

    if np.linalg.matrix_rank(X) < X.shape[1]:
        return fail(
            "Matriz de diseño singular o con rango deficiente: "
            "hay variables X constantes o perfectamente colineales."
        )

    try:
        if se_type == "classic":
            results = sm.OLS(y, X).fit()
        else:
            # HC1/HC3: mismos betas, covarianza robusta a heterocedasticidad.
            results = sm.OLS(y, X).fit(cov_type=se_type)
    except Exception as exc:
        return fail("statsmodels no pudo estimar el modelo OLS: " + str(exc) + ".")

    # Test de restricción lineal Rβ = q sobre el OLS no restringido (Wald/F test
    # de statsmodels, que ya usa la covarianza robusta cuando se_type != classic).
    # No re-estima β: sólo evalúa si la restricción es compatible con los datos.
    # R actúa sobre [Intercept, x_labels...] en ese orden, igual que en Lite
    # (quantbay/src/rls.ts).
    rls_json = chartbay_rls_constraint_json
    rls_test = None
    if rls_json:
        try:
            constraint = json.loads(rls_json)
            R = np.array(constraint["R"], dtype=float)
            q = np.array(constraint["q"], dtype=float)
        except Exception as exc:
            return fail("Restricción RLS inválida: no se pudo interpretar R/q (" + str(exc) + ").")

        if R.ndim != 2 or R.shape[1] != X.shape[1]:
            got = R.shape[1] if R.ndim == 2 else 0
            return fail(
                "La restricción RLS tiene " + str(got) + " columna(s) pero el modelo tiene "
                + str(X.shape[1]) + " parámetros (intercepto + variables): "
                "la restricción no coincide con los coeficientes estimados."
            )
        if q.ndim != 1 or q.shape[0] != R.shape[0]:
            return fail(
                "La restricción RLS tiene " + str(R.shape[0]) + " fila(s) en R pero "
                + str(q.shape[0] if q.ndim == 1 else 0) + " valor(es) en q."
            )

        try:
            f_test = results.f_test((R, q))
        except Exception as exc:
            return fail("statsmodels no pudo evaluar la restricción RLS: " + str(exc) + ".")

        def scalar_or_none(value):
            try:
                arr = np.asarray(value, dtype=float).reshape(-1)
                return finite_or_none(arr[0]) if arr.size > 0 else None
            except Exception:
                return None

        f_stat_rls = scalar_or_none(f_test.fvalue)
        f_pvalue_rls = scalar_or_none(f_test.pvalue)
        rls_test = {
            "label": constraint.get("label", "Restricción lineal"),
            "fStat": f_stat_rls,
            "fPValue": f_pvalue_rls,
            "dfNum": int(f_test.df_num) if f_test.df_num is not None else None,
            "dfDenom": int(f_test.df_denom) if f_test.df_denom is not None else None,
            "reject": bool(f_pvalue_rls is not None and f_pvalue_rls < 0.05),
        }

    names = ["Intercept"] + x_labels
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
        "functionalForm": form,
        "yName": y_label,
        "xNames": x_labels,
        "seType": se_type,
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
        "rlsTest": rls_test,
    }


json.dumps(_chartbay_pro_ols())
`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs an OLS regression with statsmodels in Python (Pyodide) in the browser.
 * Never throws — every failure mode is returned as {ok: false, error}.
 * standardErrorType llega como string crudo (viene de un <select>) y se valida
 * acá: un valor inválido devuelve error sin cargar ni ejecutar Python.
 */
export async function runPyodideOls(
  args: {
    csvText: string;
    yName: string;
    xNames: string[];
    form: FunctionalForm;
    rlsConstraint?: RLSConstraint;
    standardErrorType?: string;
  },
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
  const seType = args.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE;
  if (!isProStandardErrorType(seType)) {
    return proError(
      `Tipo de errores estándar inválido: "${seType}". Valores permitidos: ${PRO_STANDARD_ERROR_TYPES.join(', ')}.`
    );
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
    pyodide.globals.set('chartbay_functional_form', args.form);
    pyodide.globals.set(
      'chartbay_rls_constraint_json',
      args.rlsConstraint ? JSON.stringify(args.rlsConstraint) : ''
    );
    pyodide.globals.set('chartbay_se_type', seType);
    const raw = await pyodide.runPythonAsync(PYTHON_OLS_SCRIPT);
    return normalizePyodideOlsResult(raw);
  } catch (err) {
    return proError(`Error ejecutando OLS con statsmodels en Python: ${errorMessage(err)}`);
  }
}
