import { getPyodide } from './pyodideLoader';
import {
  normalizePyodideTimeSeriesResult,
  tsError,
  type PyodideTimeSeriesInput,
  type PyodideTimeSeriesResult,
} from './proTimeSeriesResultTypes';
import { validateProTimeSeriesInput } from './proTimeSeriesValidation';

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
// IMPORTANTE — alcance: esto es SÓLO diagnóstico. NO estima ARIMA. Prepara el
// terreno para ARIMA identificando estacionariedad (ADF) y rezagos candidatos
// (ACF/PACF), pero no ajusta ningún modelo AR/MA/ARIMA.
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

import numpy as np
from statsmodels.tsa.stattools import adfuller, acf, pacf
from statsmodels.stats.diagnostic import acorr_ljungbox


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
    const raw = await pyodide.runPythonAsync(PYTHON_TIME_SERIES_SCRIPT);
    const result = normalizePyodideTimeSeriesResult(raw);
    // Las advertencias de la validación TS (valores descartados, maxLag
    // recortado, etc.) se anteponen a las de Python para que el usuario las vea.
    if (result.ok && warnings.length > 0) {
      return { ...result, warnings: [...warnings, ...result.warnings] };
    }
    return result;
  } catch (err) {
    return tsError(`Error ejecutando diagnósticos de series de tiempo con statsmodels en Python: ${errorMessage(err)}`);
  }
}
