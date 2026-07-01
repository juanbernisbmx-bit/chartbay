import { getPyodide } from './pyodideLoader';
import { normalizePyodideOlsResult, proError, type PyodideOlsResult } from './proResultTypes';

export type PyodideOlsPhase = 'loading-pyodide' | 'loading-packages' | 'running';

// OLS via NumPy lstsq — deliberately minimal: the goal of this POC is to prove
// the JS↔Python bridge, not to replace the Lite engine or match statsmodels.
// Validation errors are returned as {ok: false, error} dicts (never raised) so
// the TS side always receives a parseable JSON payload.
const PYTHON_OLS_SCRIPT = `
import io
import json

import numpy as np
import pandas as pd


def _chartbay_pro_ols():
    def fail(message):
        return {"ok": False, "engine": "pyodide", "warnings": [], "error": message}

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

    data = pd.DataFrame(numeric).dropna()
    n_dropped = len(df) - len(data)
    if n_dropped > 0:
        warnings.append("Se descartaron " + str(n_dropped) + " filas con valores faltantes o no numéricos.")

    n_params = len(x_names) + 1
    if len(data) < n_params + 1:
        return fail(
            "Observaciones insuficientes: hay " + str(len(data))
            + " filas válidas y el modelo necesita al menos " + str(n_params + 1) + "."
        )

    y = data[y_name].to_numpy(dtype=float)
    X = np.column_stack([np.ones(len(y))] + [data[c].to_numpy(dtype=float) for c in x_names])

    if np.linalg.matrix_rank(X) < X.shape[1]:
        return fail(
            "Matriz de diseño singular o con rango deficiente: "
            "hay variables X constantes o perfectamente colineales."
        )

    beta, _, _, _ = np.linalg.lstsq(X, y, rcond=None)
    fitted = X @ beta
    resid = y - fitted
    rss = float(np.sum(resid ** 2))
    tss = float(np.sum((y - np.mean(y)) ** 2))
    r2 = None if tss <= 0 else 1.0 - rss / tss
    dof = max(len(y) - X.shape[1], 1)
    names = ["Intercept"] + x_names

    return {
        "ok": True,
        "engine": "pyodide",
        "nobs": int(len(y)),
        "coefficients": [
            {"name": names[i], "estimate": float(beta[i])}
            for i in range(len(names))
        ],
        "rSquared": None if r2 is None else float(r2),
        "residualStdError": float(np.sqrt(rss / dof)),
        "warnings": warnings,
    }


json.dumps(_chartbay_pro_ols())
`;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runs a basic OLS regression in Python (Pyodide) in the browser.
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
    await pyodide.loadPackage(['numpy', 'pandas']);
  } catch (err) {
    return proError(`No se pudieron cargar numpy/pandas en el navegador: ${errorMessage(err)}`);
  }

  try {
    onPhase?.('running');
    pyodide.globals.set('chartbay_csv_text', args.csvText);
    pyodide.globals.set('chartbay_y_name', args.yName);
    pyodide.globals.set('chartbay_x_names_json', JSON.stringify(args.xNames));
    const raw = await pyodide.runPythonAsync(PYTHON_OLS_SCRIPT);
    return normalizePyodideOlsResult(raw);
  } catch (err) {
    return proError(`Error ejecutando OLS en Python: ${errorMessage(err)}`);
  }
}
