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

export interface PyodideOlsInput {
  csvText: string;
  yName: string;
  xNames: string[];
  dummyNames?: string[];
  form: FunctionalForm;
  rlsConstraint?: RLSConstraint;
  standardErrorType?: string;
  hacMaxLags?: number | null;
  dropIncompleteRows?: boolean;
}

// OLS con statsmodels.api.OLS — con las 4 formas funcionales (lin-lin,
// log-lin, lin-log, log-log), errores estándar clásicos o robustos HC1/HC3/HAC
// (cov_type de statsmodels), diagnóstico de heterocedasticidad Breusch-Pagan
// y test de restricciones lineales (Rβ = q) vía statsmodels' f_test.
// IMPORTANTE: el modelo estimado y devuelto (coeficientes,
// residuos, R², etc.) es SIEMPRE el OLS no restringido — la restricción no
// re-estima los coeficientes, sólo evalúa (Wald/F) si es compatible con los
// datos. Esto es intencional: es lo que statsmodels ofrece de forma nativa y
// evita reimplementar la álgebra de mínimos cuadrados restringidos en Python.
// Lite, en cambio, sí re-estima β bajo la restricción (ver rls.ts) — por eso
// nunca se comparan los coeficientes de Lite-RLS contra los de Pro; sólo se
// compara el test de restricción en sí (ver pro/liteComparison.ts).
// Variables categóricas: el encoding a dummies (drop_first, categoría base,
// nombres) se hace SIEMPRE en TypeScript (categoricalEncoding.ts, la misma
// lógica que usa Lite) antes de llegar acá — Python nunca ve una columna de
// texto ni corre pd.get_dummies. xNames ya viene expandido a las dummies
// finales (0/1) y dummyNames indica cuáles de esas columnas son dummies, para
// no aplicarles log() bajo lin-log/log-log (ver el loop de log_x más abajo).
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
from statsmodels.stats.diagnostic import het_breuschpagan


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
    # Columns within x_names that are 0/1 dummies from categorical encoding
    # (already built in TypeScript) — never log-transformed, see the x_columns
    # loop below.
    dummy_names = set(json.loads(chartbay_dummy_names_json))
    form = chartbay_functional_form
    log_y = form in ("log-lin", "log-log")
    log_x = form in ("lin-log", "log-log")
    se_type = chartbay_se_type
    hac_max_lags = chartbay_hac_max_lags
    drop_incomplete = bool(chartbay_drop_incomplete)

    # El lado TS ya valida esto antes de ejecutar Python; se repite acá para que
    # un valor corrupto nunca llegue a statsmodels como cov_type arbitrario.
    if se_type not in ("classic", "HC1", "HC3", "HAC"):
        return fail(
            'Tipo de errores estándar no soportado: "' + str(se_type) + '". Usá classic, HC1, HC3 o HAC.'
        )

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
    blank = {}
    unparsed = {}
    for col in [y_name] + x_names:
        raw_col = df[col]
        converted = pd.to_numeric(raw_col, errors="coerce")
        if converted.notna().sum() == 0:
            kind = "Y" if col == y_name else "X"
            return fail("La columna " + kind + ' "' + col + '" no contiene valores numéricos.')
        # Celda vacía y celda con texto son dos problemas distintos, y Lite los
        # trata distinto (missing_values vs invalid_numeric). Antes Pro los
        # mezclaba en un solo descarte silencioso.
        is_blank = raw_col.isna() | raw_col.astype(str).str.strip().eq("")
        blank[col] = is_blank
        unparsed[col] = converted.isna() & ~is_blank
        numeric[col] = converted

    # Texto no numérico frena siempre, tildado o no el listwise: es un error de
    # lectura del archivo, no una decisión sobre datos que faltan.
    unparsed_cols = [col for col in numeric if bool(unparsed[col].any())]
    if unparsed_cols:
        return fail(
            "Hay valores con texto o formato no numérico en: "
            + ", ".join('"' + c + '"' for c in unparsed_cols)
            + ". Revisá separadores decimales, símbolos y celdas mezcladas con palabras."
        )

    # ±inf cuenta como valor inválido igual que NaN: se descarta la fila entera.
    frame = pd.DataFrame(numeric).replace([np.inf, -np.inf], np.nan)
    n_dropped = int(frame.isna().any(axis=1).sum())
    if n_dropped > 0 and not drop_incomplete:
        return fail(
            "Hay " + str(n_dropped) + " fila(s) con celdas vacías o valores infinitos en las columnas "
            "del modelo. Completá esos datos, o tildá \\"Excluir las filas con datos faltantes "
            "(listwise)\\" para estimar sin esas filas."
        )
    data = frame.dropna().reset_index(drop=True)
    if n_dropped > 0:
        warnings.append(
            "Listwise: se excluyó 1 fila con celdas vacías o valores infinitos."
            if n_dropped == 1
            else "Listwise: se excluyeron " + str(n_dropped) + " filas con celdas vacías o valores infinitos."
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
        if log_x and col not in dummy_names:
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

    hac_lags_used = None
    try:
        if se_type == "classic":
            results = sm.OLS(y, X).fit()
        elif se_type == "HAC":
            # Newey-West. statsmodels NO tiene default para maxlags: sin la clave
            # en cov_kwds tira KeyError. Cuando no se eligió un rezago usamos la
            # regla de dedo habitual L = floor(4·(n/100)^(2/9)), acotada a n-1
            # para no pedir más rezagos que observaciones.
            n_obs = int(X.shape[0])
            lags = hac_max_lags if hac_max_lags is not None else math.floor(4 * (n_obs / 100.0) ** (2.0 / 9.0))
            hac_lags_used = int(max(0, min(int(lags), n_obs - 1)))
            # Sin use_correction, que es el default de statsmodels: lo que
            # muestra ChartBay tiene que ser lo que devuelve statsmodels.
            results = sm.OLS(y, X).fit(cov_type="HAC", cov_kwds={"maxlags": hac_lags_used})
        else:
            # HC1/HC3: mismos betas, covarianza robusta a heterocedasticidad.
            results = sm.OLS(y, X).fit(cov_type=se_type)
    except Exception as exc:
        return fail("statsmodels no pudo estimar el modelo OLS: " + str(exc) + ".")

    # Breusch-Pagan sobre el modelo efectivamente estimado: usa los residuos y
    # la matriz de diseño (results.model.exog) YA transformados por la forma
    # funcional, así que funciona igual para lin-lin/log-lin/lin-log/log-log
    # sin ningún caso especial acá. Es un diagnóstico adicional, no crítico: si
    # falla, no aborta el resultado completo, sólo queda ausente con una advertencia.
    try:
        bp_lm, bp_lm_pvalue, bp_fvalue, bp_f_pvalue = het_breuschpagan(results.resid, results.model.exog)
        bp_lm = finite_or_none(bp_lm)
        bp_lm_pvalue = finite_or_none(bp_lm_pvalue)
        bp_fvalue = finite_or_none(bp_fvalue)
        bp_f_pvalue = finite_or_none(bp_f_pvalue)
        if None in (bp_lm, bp_lm_pvalue, bp_fvalue, bp_f_pvalue):
            breusch_pagan = None
            warnings.append("No se pudo calcular Breusch-Pagan: statsmodels devolvió un estadístico no finito.")
        else:
            # La conclusión pedagógica usa el p-value del F (más citado en la
            # práctica); el LM también se devuelve completo para quien lo prefiera.
            bp_reject = bp_f_pvalue < 0.05
            breusch_pagan = {
                "lmStatistic": bp_lm,
                "lmPValue": bp_lm_pvalue,
                "fStatistic": bp_fvalue,
                "fPValue": bp_f_pvalue,
                "rejectAt5": bp_reject,
                "interpretation": (
                    "Se rechaza homocedasticidad al 5% (evidencia de heterocedasticidad)."
                    if bp_reject else
                    "No se rechaza homocedasticidad al 5% (sin evidencia suficiente de heterocedasticidad)."
                ),
            }
    except Exception as exc:
        breusch_pagan = None
        warnings.append("No se pudo calcular Breusch-Pagan: " + str(exc) + ".")

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
    confidence_intervals = results.conf_int(alpha=0.05)
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
            "confidenceInterval": [
                finite_or_none(confidence_intervals[i][0]),
                finite_or_none(confidence_intervals[i][1]),
            ],
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
        "hacMaxLags": hac_lags_used,
        "nobs": int(results.nobs),
        "coefficients": coefficients,
        "rSquared": r_squared,
        "rSquaredAdj": finite_or_none(results.rsquared_adj),
        "fStat": f_stat,
        "fPValue": f_pvalue,
        "aic": finite_or_none(results.aic),
        "bic": finite_or_none(results.bic),
        "dfResid": int(results.df_resid),
        "residualStdError": residual_std_error,
        "residuals": residuals,
        "fitted": fitted,
        "warnings": warnings,
        "rlsTest": rls_test,
        "breuschPagan": breusch_pagan,
    }


json.dumps(_chartbay_pro_ols())
`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Serializes already-encoded rows (categorical dummies already added as 0/1
// columns, via categoricalEncoding.ts) back into CSV text so Python's
// pd.read_csv pipeline can consume them unchanged — Python never builds
// dummies itself. Only needed when categorical encoding actually created
// dummy columns; plain numeric-only runs keep sending the original upload's
// csvText untouched (see main.ts).
export function buildEncodedCsvText(rows: Record<string, unknown>[], columns: string[]): string {
  const escapeCsvValue = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map(col => escapeCsvValue(row[col])).join(','));
  }
  return lines.join('\n');
}

/**
 * Runs an OLS regression with statsmodels in Python (Pyodide) in the browser.
 * Never throws — every failure mode is returned as {ok: false, error}.
 * standardErrorType llega como string crudo (viene de un <select>) y se valida
 * acá: un valor inválido devuelve error sin cargar ni ejecutar Python.
 */
export async function runPyodideOls(
  args: PyodideOlsInput,
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
  // Se valida acá y no en Python porque el <input> es del lado TS: así el error
  // vuelve al instante en vez de después de arrancar Pyodide.
  const hacMaxLags = args.hacMaxLags ?? null;
  if (hacMaxLags !== null && (!Number.isInteger(hacMaxLags) || hacMaxLags < 0)) {
    return proError(
      `Rezagos HAC inválidos: "${hacMaxLags}". Tiene que ser un entero >= 0, o vacío para el cálculo automático.`
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
    pyodide.globals.set('chartbay_dummy_names_json', JSON.stringify(args.dummyNames ?? []));
    pyodide.globals.set('chartbay_functional_form', args.form);
    pyodide.globals.set(
      'chartbay_rls_constraint_json',
      args.rlsConstraint ? JSON.stringify(args.rlsConstraint) : ''
    );
    pyodide.globals.set('chartbay_se_type', seType);
    pyodide.globals.set('chartbay_hac_max_lags', hacMaxLags);
    pyodide.globals.set('chartbay_drop_incomplete', args.dropIncompleteRows ?? false);
    const raw = await pyodide.runPythonAsync(PYTHON_OLS_SCRIPT);
    return normalizePyodideOlsResult(raw);
  } catch (err) {
    return proError(`Error ejecutando OLS con statsmodels en Python: ${errorMessage(err)}`);
  }
}
