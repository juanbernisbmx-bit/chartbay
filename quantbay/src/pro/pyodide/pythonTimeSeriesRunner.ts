import { getPyodide } from './pyodideLoader';
import {
  normalizePyodideTimeSeriesResult,
  tsError,
  type ProArimaOrder,
  type PyodideTimeSeriesInput,
  type PyodideTimeSeriesResult,
} from './proTimeSeriesResultTypes';
import { validateProArimaOrder, validateProTimeSeriesInput } from './proTimeSeriesValidation';

export type PyodideTimeSeriesPhase = 'loading-pyodide' | 'loading-packages' | 'running';

// Diagnósticos de series de tiempo con statsmodels vía Pyodide:
//   - ADF (statsmodels.tsa.stattools.adfuller) con autolag="AIC".
//   - ACF y PACF (statsmodels.tsa.stattools.acf / pacf).
//   - Ljung-Box (statsmodels.stats.diagnostic.acorr_ljungbox).
//
// PACF: se usa method="ywm" (Yule-Walker "modified"/mle-adjusted), estable y
// compatible con la versión de statsmodels que trae Pyodide, y con el mismo
// espíritu que el estimador biased del motor Lite (quantbay/src/timeseries/acf.ts).
//
// Además de los diagnósticos, el script estima ARIMA(p,d,q) MANUAL sólo cuando
// el usuario lo activa (run_arima). El orden lo elige el usuario — NO hay
// auto-ARIMA (selección automática del orden) en esta fase. ARIMA es totalmente
// independiente de los diagnósticos: si falla, los diagnósticos ADF/ACF/PACF/
// Ljung-Box siguen presentes y la sección ARIMA muestra un error controlado.
//
// Convención de errores idéntica a la del OLS Pro (pythonOlsRunner.ts): los
// errores de validación se devuelven como dicts {ok: false, error} (nunca se
// lanzan) para que el lado TS siempre reciba un JSON parseable; los estadísticos
// no finitos se serializan como null porque JSON.parse rechaza NaN/Infinity.
// Cada diagnóstico va en su propio try/except: si statsmodels falla SÓLO en uno
// (p. ej. PACF por muestra corta), ese queda en null con una advertencia y el
// resto del resultado se conserva.
const PYTHON_TIME_SERIES_SCRIPT = `
import json
import math
import warnings as py_warnings

import numpy as np
from statsmodels.tsa.stattools import adfuller, acf, pacf
from statsmodels.stats.diagnostic import acorr_ljungbox
from statsmodels.tsa.arima.model import ARIMA


def _chartbay_pro_time_series():
    def fail(message):
        return {"ok": False, "engine": "pyodide", "warnings": [], "error": message}

    def finite_or_none(value):
        try:
            value = float(value)
        except (TypeError, ValueError):
            return None
        return value if math.isfinite(value) else None

    name = chartbay_ts_name
    max_lag = int(chartbay_ts_max_lag)
    adf_regression = chartbay_ts_adf_regression
    ljung_box_lags = [int(l) for l in json.loads(chartbay_ts_ljung_box_lags_json)]
    run_arima = bool(chartbay_ts_run_arima)

    if adf_regression not in ("c", "ct", "ctt", "n"):
        return fail('Tipo de regresión ADF no soportado: "' + str(adf_regression) + '". Usá c, ct, ctt o n.')

    try:
        raw_values = json.loads(chartbay_ts_values_json)
    except Exception as exc:
        return fail("No se pudieron leer los valores de la serie (" + str(exc) + ").")

    arr = np.asarray(raw_values, dtype=float)
    arr = arr[np.isfinite(arr)]
    n = int(arr.size)

    # Defensa en profundidad: el lado TS ya valida esto (MIN_PRO_TS_OBSERVATIONS)
    # antes de ejecutar Python, pero se repite acá para nunca correr statsmodels
    # sobre una serie demasiado corta o constante.
    if n < 12:
        return fail(
            "La serie necesita suficientes observaciones válidas para calcular diagnósticos de series de tiempo "
            "(al menos 12; hay " + str(n) + ")."
        )
    if float(np.ptp(arr)) == 0.0:
        return fail("La serie es constante; no se pueden calcular ADF/ACF/PACF de forma significativa.")

    warnings = []
    result = {
        "ok": True,
        "engine": "pyodide",
        "variableName": name,
        "observations": n,
        "adfRegression": adf_regression,
        "maxLag": max_lag,
        "adf": None,
        "acf": None,
        "pacf": None,
        "ljungBox": None,
        "warnings": warnings,
    }

    # ── ADF ───────────────────────────────────────────────────────────────
    # H0: la serie tiene raíz unitaria (no es estacionaria). autolag="AIC"
    # elige el número de rezagos; adfuller devuelve
    # (stat, pvalue, usedlag, nobs, critvalues, icbest).
    try:
        adf_out = adfuller(arr, regression=adf_regression, autolag="AIC")
        crit = adf_out[4] if len(adf_out) > 4 else {}
        ic_best = adf_out[5] if len(adf_out) > 5 else None
        result["adf"] = {
            "statistic": finite_or_none(adf_out[0]),
            "pValue": finite_or_none(adf_out[1]),
            "usedLag": int(adf_out[2]),
            "nobs": int(adf_out[3]),
            "criticalValues": {str(k): finite_or_none(v) for k, v in dict(crit).items()},
            "icBest": finite_or_none(ic_best),
        }
    except Exception as exc:
        result["adf"] = None
        warnings.append("No se pudo calcular ADF: " + str(exc) + ".")

    # ── ACF ───────────────────────────────────────────────────────────────
    # acf() devuelve el lag 0 (=1.0) en la posición 0; se reporta desde lag 1.
    try:
        acf_vals = acf(arr, nlags=max_lag, fft=False)
        result["acf"] = [
            {"lag": i, "value": finite_or_none(acf_vals[i])} for i in range(1, len(acf_vals))
        ]
    except Exception as exc:
        result["acf"] = None
        warnings.append("No se pudo calcular ACF: " + str(exc) + ".")

    # ── PACF ──────────────────────────────────────────────────────────────
    # method="ywm": Yule-Walker modificado, estable en Pyodide. Igual que acf,
    # el lag 0 va en la posición 0 y se reporta desde lag 1.
    try:
        pacf_vals = pacf(arr, nlags=max_lag, method="ywm")
        result["pacf"] = [
            {"lag": i, "value": finite_or_none(pacf_vals[i])} for i in range(1, len(pacf_vals))
        ]
    except Exception as exc:
        result["pacf"] = None
        warnings.append("No se pudo calcular PACF: " + str(exc) + ".")

    # ── Ljung-Box ─────────────────────────────────────────────────────────
    # H0: no hay autocorrelación conjunta hasta ese rezago. return_df=True
    # devuelve un DataFrame con columnas lb_stat / lb_pvalue indexado por rezago.
    try:
        lb = acorr_ljungbox(arr, lags=ljung_box_lags, return_df=True)
        rows = []
        for lag in ljung_box_lags:
            rows.append({
                "lag": int(lag),
                "statistic": finite_or_none(lb.loc[lag, "lb_stat"]),
                "pValue": finite_or_none(lb.loc[lag, "lb_pvalue"]),
            })
        result["ljungBox"] = rows
    except Exception as exc:
        result["ljungBox"] = None
        warnings.append("No se pudo calcular Ljung-Box: " + str(exc) + ".")

    # ── ARIMA manual (opcional) ───────────────────────────────────────────
    # Sólo se estima si el usuario lo activó (run_arima) y el orden ya pasó la
    # validación TS (p/d/q enteros, límites, observaciones suficientes). ARIMA
    # NO afecta los diagnósticos de arriba: si falla, quedan intactos y sólo la
    # sección ARIMA reporta el problema (arima=None + arimaError).
    if run_arima:
        try:
            order_cfg = json.loads(chartbay_ts_arima_order_json)
            p = int(order_cfg["p"])
            d = int(order_cfg["d"])
            q = int(order_cfg["q"])
        except Exception as exc:
            run_arima = False
            result["arima"] = None
            result["arimaError"] = "Orden ARIMA inválido (" + str(exc) + ")."

    if run_arima:
        try:
            # Captura de warnings de statsmodels (convergencia, etc.) como
            # advertencias pedagógicas. Se descartan los avisos de índice/frecuencia
            # (no aportan al usuario). El módulo se importa como py_warnings porque
            # 'warnings' ya es la lista de advertencias de los diagnósticos.
            caught = []
            skip_tokens = ("frequency", "date index", "unsupported index", "no supported index")
            with py_warnings.catch_warnings(record=True) as caught_warnings:
                py_warnings.simplefilter("always")
                fit = ARIMA(arr, order=(p, d, q)).fit()
            for w in caught_warnings:
                msg = str(w.message)
                low = msg.lower()
                if any(tok in low for tok in skip_tokens):
                    continue
                if msg and msg not in caught:
                    caught.append(msg)

            # Convergencia: sólo si statsmodels la expone (no se inventa).
            converged = None
            retvals = getattr(fit, "mle_retvals", None)
            if isinstance(retvals, dict) and "converged" in retvals:
                converged = bool(retvals["converged"])

            names = getattr(fit, "param_names", None)
            if names is None:
                names = getattr(getattr(fit, "model", None), "param_names", [])
            names = [str(nm) for nm in list(names)]
            params = np.asarray(fit.params, dtype=float).reshape(-1)
            bse = np.asarray(fit.bse, dtype=float).reshape(-1)
            zvalues = np.asarray(fit.tvalues, dtype=float).reshape(-1)
            pvalues = np.asarray(fit.pvalues, dtype=float).reshape(-1)
            coefficients = []
            for i in range(len(names)):
                coefficients.append({
                    "name": names[i],
                    "estimate": finite_or_none(params[i]) if i < params.size else None,
                    "standardError": finite_or_none(bse[i]) if i < bse.size else None,
                    "zStatistic": finite_or_none(zvalues[i]) if i < zvalues.size else None,
                    "pValue": finite_or_none(pvalues[i]) if i < pvalues.size else None,
                })

            result["arima"] = {
                "order": {"p": p, "d": d, "q": q},
                "converged": converged,
                "nobs": int(fit.nobs),
                "logLikelihood": finite_or_none(fit.llf),
                "aic": finite_or_none(fit.aic),
                "bic": finite_or_none(fit.bic),
                "hqic": finite_or_none(fit.hqic),
                "coefficients": coefficients,
                "warnings": caught,
            }

            # Ljung-Box sobre los residuos del ARIMA: si no rechaza, el modelo
            # capturó razonablemente la dependencia temporal.
            try:
                resid = np.asarray(fit.resid, dtype=float)
                resid = resid[np.isfinite(resid)]
                resid_lags = [l for l in ljung_box_lags if l < len(resid)]
                if len(resid_lags) > 0:
                    lb_resid = acorr_ljungbox(resid, lags=resid_lags, return_df=True)
                    resid_rows = []
                    for lag in resid_lags:
                        resid_rows.append({
                            "lag": int(lag),
                            "statistic": finite_or_none(lb_resid.loc[lag, "lb_stat"]),
                            "pValue": finite_or_none(lb_resid.loc[lag, "lb_pvalue"]),
                        })
                    result["arimaResidualDiagnostics"] = {"ljungBox": resid_rows}
            except Exception as exc:
                result["arima"]["warnings"].append(
                    "No se pudo calcular Ljung-Box sobre los residuos: " + str(exc) + "."
                )
        except Exception as exc:
            result["arima"] = None
            result["arimaError"] = (
                "No se pudo estimar ARIMA con este orden. Probá un modelo más simple o revisá si la serie "
                "tiene suficientes observaciones. (" + str(exc) + ")"
            )

    return result


json.dumps(_chartbay_pro_time_series())
`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Corre los diagnósticos de series de tiempo Pro (ADF, ACF, PACF, Ljung-Box)
 * con statsmodels en Python (Pyodide) en el navegador. Nunca lanza — cada modo
 * de falla se devuelve como {ok: false, error}. La serie se limpia y valida en
 * TS (validateProTimeSeriesInput) antes de cargar/ejecutar Python.
 */
export async function runPyodideTimeSeries(
  input: PyodideTimeSeriesInput,
  onPhase?: (phase: PyodideTimeSeriesPhase) => void
): Promise<PyodideTimeSeriesResult> {
  const validated = validateProTimeSeriesInput(input);
  if (!validated.ok) {
    return tsError(validated.error);
  }
  const { values, variableName, maxLag, adfRegression, ljungBoxLags, warnings } = validated.value;

  // ARIMA opcional. Si el orden es inválido NO se aborta la corrida: los
  // diagnósticos se calculan igual y el error se muestra en la sección ARIMA.
  let runArimaInPython = false;
  let arimaOrderForPython: ProArimaOrder | null = null;
  let tsArimaError: string | null = null;
  if (input.runArima) {
    const arimaValidation = validateProArimaOrder(input.arimaOrder, values.length);
    if (arimaValidation.ok) {
      runArimaInPython = true;
      arimaOrderForPython = arimaValidation.value;
    } else {
      tsArimaError = arimaValidation.error;
    }
  }

  let pyodide;
  try {
    onPhase?.('loading-pyodide');
    pyodide = await getPyodide();
  } catch (err) {
    return tsError(`No se pudo cargar Pyodide (Python en el navegador): ${errorMessage(err)}`);
  }

  try {
    onPhase?.('loading-packages');
    await pyodide.loadPackage(['numpy', 'pandas', 'statsmodels']);
  } catch (err) {
    return tsError(`No se pudieron cargar numpy/pandas/statsmodels en el navegador: ${errorMessage(err)}`);
  }

  try {
    onPhase?.('running');
    pyodide.globals.set('chartbay_ts_name', variableName);
    pyodide.globals.set('chartbay_ts_values_json', JSON.stringify(values));
    pyodide.globals.set('chartbay_ts_max_lag', maxLag);
    pyodide.globals.set('chartbay_ts_adf_regression', adfRegression);
    pyodide.globals.set('chartbay_ts_ljung_box_lags_json', JSON.stringify(ljungBoxLags));
    pyodide.globals.set('chartbay_ts_run_arima', runArimaInPython);
    pyodide.globals.set(
      'chartbay_ts_arima_order_json',
      JSON.stringify(arimaOrderForPython ?? { p: 0, d: 0, q: 0 })
    );
    const raw = await pyodide.runPythonAsync(PYTHON_TIME_SERIES_SCRIPT);
    const result = normalizePyodideTimeSeriesResult(raw);
    if (!result.ok) return result;

    // Las advertencias de la validación TS (valores descartados, maxLag
    // recortado, etc.) se anteponen a las de Python para que el usuario las vea.
    const merged: PyodideTimeSeriesResult = warnings.length > 0
      ? { ...result, warnings: [...warnings, ...result.warnings] }
      : result;
    // Un orden ARIMA inválido (validación TS) no llegó a Python: se reporta acá
    // como error controlado de la sección ARIMA, sin tocar los diagnósticos.
    if (tsArimaError) merged.arimaError = tsArimaError;
    return merged;
  } catch (err) {
    return tsError(`Error ejecutando diagnósticos de series de tiempo con statsmodels en Python: ${errorMessage(err)}`);
  }
}
