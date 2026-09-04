(function(){"use strict";const P="/static/vendor/pyodide/0.26.4/",k=`${P}pyodide.js`,$=`${P}pyodide-lock.json`,H=["statsmodels"];let S="idle",N=null,j=null;function X(){const e=globalThis;if(typeof document>"u"&&typeof e.importScripts=="function")try{return e.importScripts(k),Promise.resolve()}catch(n){return Promise.reject(new Error(`No se pudo cargar Pyodide desde ChartBay (${k}): ${n instanceof Error?n.message:String(n)}`))}return new Promise((n,r)=>{const o=document.createElement("script");o.src=k,o.async=!0,o.onload=()=>n(),o.onerror=()=>{o.remove(),r(new Error(`No se pudo cargar Pyodide desde ChartBay (${k}). Recargá la página e intentá de nuevo.`))},document.head.appendChild(o)})}async function Y(e){N="loading-pyodide",e==null||e(N);const n=globalThis;if(typeof n.loadPyodide!="function"&&await X(),typeof n.loadPyodide!="function")throw new Error("El script de Pyodide cargó pero loadPyodide no está disponible. Recargá la página e intentá de nuevo.");return N="loading-packages",e==null||e(N),n.loadPyodide({indexURL:P,lockFileURL:$,packages:H})}async function R(e){return j?S==="loading"&&N&&(e==null||e(N)):(S="loading",j=Y(e).then(n=>(S="ready",N=null,n),n=>{throw S="error",N=null,j=null,n})),j}const U=["classic","HC1","HC3","HAC"],J="classic";function L(e){return e==="classic"||e==="HC1"||e==="HC3"||e==="HAC"}const W=new Set(["lin-lin","log-lin","lin-log","log-log"]);function i(e){return{ok:!1,engine:"pyodide",warnings:[],error:e}}function b(e){if(e===null)return null;if(typeof e=="number"&&Number.isFinite(e))return e}function G(e){if(!Array.isArray(e)||e.length===0)return null;const n=[];for(const r of e){if(r===null||typeof r!="object")return null;const o=r,{name:a,estimate:t}=o;if(typeof a!="string"||typeof t!="number"||!Number.isFinite(t)||!("stdError"in o)||!("tStat"in o)||!("pValue"in o))return null;const s=b(o.stdError),l=b(o.tStat),f=b(o.pValue);if(s===void 0||l===void 0||f===void 0)return null;let c;if(o.confidenceInterval!==void 0)if(o.confidenceInterval===null)c=null;else if(Array.isArray(o.confidenceInterval)&&o.confidenceInterval.length===2){const u=b(o.confidenceInterval[0]),_=b(o.confidenceInterval[1]);if(u===void 0||_===void 0)return null;c=u===null||_===null?null:[u,_]}else return null;n.push({name:a,estimate:t,stdError:s,tStat:l,pValue:f,confidenceInterval:c})}return n}function K(e){if(e==null)return{ok:!0,value:void 0};if(typeof e!="object"||Array.isArray(e))return{ok:!1};const n=e;if(typeof n.label!="string"||n.label.trim()==="")return{ok:!1};const r=b(n.fStat),o=b(n.fPValue);if(r===void 0||o===void 0)return{ok:!1};const a=b(n.dfNum),t=b(n.dfDenom);return a===void 0||t===void 0?{ok:!1}:typeof n.reject!="boolean"?{ok:!1}:{ok:!0,value:{label:n.label,fStat:r,fPValue:o,dfNum:a,dfDenom:t,reject:n.reject}}}function Q(e){if(e==null)return{ok:!0,value:void 0};if(typeof e!="object"||Array.isArray(e))return{ok:!1};const n=e,r=n.lmStatistic,o=n.lmPValue,a=n.fStatistic,t=n.fPValue;return typeof r!="number"||!Number.isFinite(r)?{ok:!1}:typeof o!="number"||!Number.isFinite(o)?{ok:!1}:typeof a!="number"||!Number.isFinite(a)?{ok:!1}:typeof t!="number"||!Number.isFinite(t)?{ok:!1}:typeof n.rejectAt5!="boolean"?{ok:!1}:typeof n.interpretation!="string"||n.interpretation.trim()===""?{ok:!1}:{ok:!0,value:{lmStatistic:r,lmPValue:o,fStatistic:a,fPValue:t,rejectAt5:n.rejectAt5,interpretation:n.interpretation}}}function w(e,n){if(!Array.isArray(e)||e.length!==n)return null;for(const r of e)if(typeof r!="number"||!Number.isFinite(r))return null;return e}function Z(e){if(typeof e!="string"||e.trim()==="")return i("El motor Python no devolvió resultados.");let n;try{n=JSON.parse(e)}catch{return i("El motor Python devolvió un resultado ilegible (JSON inválido).")}if(n===null||typeof n!="object"||Array.isArray(n))return i("El motor Python devolvió un resultado con formato inesperado.");const r=n,o=Array.isArray(r.warnings)?r.warnings.filter(E=>typeof E=="string"):[];if(r.ok!==!0){const E=typeof r.error=="string"&&r.error.trim()!==""?r.error:"Error desconocido en el motor Python.";return{ok:!1,engine:"pyodide",warnings:o,error:E}}if(typeof r.functionalForm!="string"||!W.has(r.functionalForm))return i("El motor Python devolvió una forma funcional inválida.");const a=r.functionalForm;if(typeof r.yName!="string"||r.yName.trim()==="")return i("El motor Python devolvió un nombre de Y inválido.");if(!Array.isArray(r.xNames)||r.xNames.length===0||!r.xNames.every(E=>typeof E=="string"))return i("El motor Python devolvió nombres de X inválidos.");let t;if(r.seType!==void 0&&r.seType!==null){if(!L(r.seType))return i("El motor Python devolvió un tipo de errores estándar inválido.");t=r.seType}const s=typeof r.hacMaxLags=="number"&&Number.isFinite(r.hacMaxLags)?r.hacMaxLags:void 0,l=G(r.coefficients);if(!l)return i("El motor Python devolvió coeficientes inválidos.");if(typeof r.nobs!="number"||!Number.isFinite(r.nobs)||r.nobs<=0)return i("El motor Python devolvió un número de observaciones inválido.");if(typeof r.dfResid!="number"||!Number.isFinite(r.dfResid)||r.dfResid<1)return i("El motor Python devolvió grados de libertad inválidos.");if(typeof r.residualStdError!="number"||!Number.isFinite(r.residualStdError))return i("El motor Python devolvió un error estándar residual inválido.");const f=w(r.residuals,r.nobs);if(!f)return i("El motor Python devolvió residuos inválidos.");const c=w(r.fitted,r.nobs);if(!c)return i("El motor Python devolvió valores ajustados inválidos.");const u=K(r.rlsTest);if(!u.ok)return i("El motor Python devolvió un test de restricción RLS inválido.");const _=Q(r.breuschPagan);if(!_.ok)return i("El motor Python devolvió un test de Breusch-Pagan inválido.");const x=b(r.rSquared),y=b(r.rSquaredAdj),m=b(r.aic),p=b(r.bic);let d=b(r.fStat),h=b(r.fPValue);return x===void 0&&r.rSquared!==void 0?i("El motor Python devolvió un R² inválido."):y===void 0&&r.rSquaredAdj!==void 0?i("El motor Python devolvió un R² ajustado inválido."):m===void 0&&r.aic!==void 0?i("El motor Python devolvió un AIC inválido."):p===void 0&&r.bic!==void 0?i("El motor Python devolvió un BIC inválido."):d===void 0&&r.fStat!==void 0?i("El motor Python devolvió un F-stat inválido."):h===void 0&&r.fPValue!==void 0?i("El motor Python devolvió un p-value del F-stat inválido."):(typeof d=="number"&&d<0&&(d=null,h=null),{ok:!0,engine:"pyodide",functionalForm:a,yName:r.yName,xNames:r.xNames,standardErrorType:t,hacMaxLags:s,nobs:r.nobs,coefficients:l,rSquared:x??void 0,rSquaredAdj:y??void 0,fStat:d??void 0,fPValue:h??void 0,aic:m??void 0,bic:p??void 0,dfResid:r.dfResid,residualStdError:r.residualStdError,residuals:f,fitted:c,warnings:o,rlsTest:u.value,breuschPagan:_.value})}const ee=`
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

    warnings = []
    if bool(chartbay_use_numeric):
        rows = int(chartbay_numeric_rows)
        columns = int(chartbay_numeric_columns)
        if rows <= 0:
            return fail("El CSV no tiene filas de datos.")
        if columns != len(x_names):
            return fail("La matriz numérica de Pro no coincide con las columnas X seleccionadas.")
        try:
            y_values = np.asarray(chartbay_y_values, dtype=float).reshape(rows)
            x_values = np.asarray(chartbay_x_values, dtype=float).reshape((rows, columns))
            numeric = {y_name: y_values}
            for idx, col in enumerate(x_names):
                numeric[col] = x_values[:, idx]
            data = pd.DataFrame(numeric)
        except Exception as exc:
            return fail("No se pudo preparar la matriz numérica de Pro (" + str(exc) + ").")
        n_dropped = int(chartbay_dropped_rows)
    else:
        try:
            df = pd.read_csv(io.StringIO(chartbay_csv_text))
        except Exception as exc:
            return fail("CSV inválido: no se pudo leer el archivo (" + str(exc) + ").")

        missing = [c for c in [y_name] + x_names if c not in df.columns]
        if missing:
            return fail("Columnas faltantes en el CSV: " + ", ".join(missing) + ".")
        if len(df) == 0:
            return fail("El CSV no tiene filas de datos.")

        numeric = {}
        unparsed = {}
        for col in [y_name] + x_names:
            raw_col = df[col]
            converted = pd.to_numeric(raw_col, errors="coerce")
            if converted.notna().sum() == 0:
                kind = "Y" if col == y_name else "X"
                return fail("La columna " + kind + ' "' + col + '" no contiene valores numéricos.')
            is_blank = raw_col.isna() | raw_col.astype(str).str.strip().eq("")
            unparsed[col] = converted.isna() & ~is_blank
            numeric[col] = converted

        unparsed_cols = [col for col in numeric if bool(unparsed[col].any())]
        if unparsed_cols:
            return fail(
                "Hay valores con texto o formato no numérico en: "
                + ", ".join('"' + c + '"' for c in unparsed_cols)
                + ". Revisá separadores decimales, símbolos y celdas mezcladas con palabras."
            )

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
`;function I(e){return e instanceof Error?e.message:String(e)}async function re(e,n){var t,s,l,f,c;if((!e.csvText||e.csvText.trim()==="")&&!e.numericData)return i("No hay CSV cargado para ejecutar en ChartBay Pro.");if(!e.yName)return i("Seleccioná una variable Y antes de ejecutar.");if(e.xNames.length===0)return i("Seleccioná al menos una variable X antes de ejecutar.");const r=e.standardErrorType??J;if(!L(r))return i(`Tipo de errores estándar inválido: "${r}". Valores permitidos: ${U.join(", ")}.`);const o=e.hacMaxLags??null;if(o!==null&&(!Number.isInteger(o)||o<0))return i(`Rezagos HAC inválidos: "${o}". Tiene que ser un entero >= 0, o vacío para el cálculo automático.`);let a;try{a=await R(n)}catch(u){return i(`No se pudo cargar Pyodide (Python en el navegador): ${I(u)}`)}try{n==null||n("running"),a.globals.set("chartbay_use_numeric",!!e.numericData),a.globals.set("chartbay_csv_text",e.csvText??""),a.globals.set("chartbay_y_values",((t=e.numericData)==null?void 0:t.yValues)??new Float64Array),a.globals.set("chartbay_x_values",((s=e.numericData)==null?void 0:s.xValues)??new Float64Array),a.globals.set("chartbay_numeric_rows",((l=e.numericData)==null?void 0:l.rows)??0),a.globals.set("chartbay_numeric_columns",((f=e.numericData)==null?void 0:f.columns)??0),a.globals.set("chartbay_dropped_rows",((c=e.numericData)==null?void 0:c.droppedRows)??0),a.globals.set("chartbay_y_name",e.yName),a.globals.set("chartbay_x_names_json",JSON.stringify(e.xNames)),a.globals.set("chartbay_dummy_names_json",JSON.stringify(e.dummyNames??[])),a.globals.set("chartbay_functional_form",e.form),a.globals.set("chartbay_rls_constraint_json",e.rlsConstraint?JSON.stringify(e.rlsConstraint):""),a.globals.set("chartbay_se_type",r),a.globals.set("chartbay_hac_max_lags",o),a.globals.set("chartbay_drop_incomplete",e.dropIncompleteRows??!1);const u=await a.runPythonAsync(ee);return Z(u)}catch(u){return i(`Error ejecutando OLS con statsmodels en Python: ${I(u)}`)}}const ne="c";function F(e){return e==="c"||e==="ct"||e==="ctt"||e==="n"}const q=5,T=2,oe=5,ae=1,C=60;function g(e){return{ok:!1,engine:"pyodide",warnings:[],error:e}}function te(e){return e!==null&&e<.05}function se(e){return e===null?"H0: la serie tiene raíz unitaria (no es estacionaria). El p-value no está disponible; compará el estadístico contra los valores críticos.":e<.05?"Se rechaza H0 al 5%: hay evidencia de estacionariedad (la serie no tendría raíz unitaria).":"No se rechaza H0 al 5%: la serie podría no ser estacionaria (posible raíz unitaria)."}function ie(e){return e!==null&&e<.05}function le(e){return e===null?"p-value no disponible para este rezago.":e<.05?"Se rechaza H0 al 5%: hay evidencia de autocorrelación hasta este rezago.":"No se rechaza H0 al 5%: sin evidencia de autocorrelación conjunta hasta este rezago."}function ce(e,n){const r=`ARIMA(${e.p},${e.d},${e.q}) combina términos autorregresivos AR(${e.p}), diferenciación d=${e.d} y media móvil MA(${e.q}). p: rezagos autorregresivos; d: cantidad de diferenciaciones; q: rezagos de errores de pronóstico.`,o=e.d>0?" El modelo se estima sobre la serie diferenciada para reducir la no estacionariedad.":"",a=n===!1?" El modelo no convergió. Probá un orden más simple o revisá la estacionariedad de la serie.":"";return r+o+a}function ue(e){return e.length===0?"No se pudo evaluar la autocorrelación de los residuos del ARIMA.":e.some(r=>r.rejectAt5)?"Ljung-Box rechaza en algún rezago: queda autocorrelación en los residuos; considerá otro orden (p, d, q).":"Si Ljung-Box no rechaza autocorrelación en los residuos, el modelo capturó razonablemente la dependencia temporal."}function v(e){if(e===null)return null;if(typeof e=="number"&&Number.isFinite(e))return e}function z(e){if(!Array.isArray(e))return null;const n=[];for(const r of e){if(r===null||typeof r!="object")return null;const o=r,a=o.lag,t=v(o.value);if(typeof a!="number"||!Number.isInteger(a)||t===void 0||t===null)return null;n.push({lag:a,value:t})}return n}function de(e){if(e===null||typeof e!="object"||Array.isArray(e))return null;const n={};for(const[r,o]of Object.entries(e)){const a=v(o);typeof a=="number"&&(n[r]=a)}return n}function fe(e){if(e==null)return{ok:!0,value:void 0};if(typeof e!="object"||Array.isArray(e))return{ok:!1};const n=e,r=v(n.statistic),o=v(n.pValue);if(r===void 0||o===void 0)return{ok:!1};const a=n.usedLag,t=n.nobs;if(typeof a!="number"||!Number.isInteger(a))return{ok:!1};if(typeof t!="number"||!Number.isInteger(t)||t<=0)return{ok:!1};const s=de(n.criticalValues);if(s===null)return{ok:!1};const l=v(n.icBest);return l===void 0?{ok:!1}:{ok:!0,value:{statistic:r,pValue:o,usedLag:a,nobs:t,criticalValues:s,icBest:l,rejectAt5:te(o),interpretation:se(o)}}}function O(e){if(!Array.isArray(e))return null;const n=[];for(const r of e){if(r===null||typeof r!="object")return null;const o=r,a=o.lag,t=v(o.statistic),s=v(o.pValue);if(typeof a!="number"||!Number.isInteger(a)||t==null||s===void 0)return null;n.push({lag:a,statistic:t,pValue:s,rejectAt5:ie(s),interpretation:le(s)})}return n}function me(e){if(e==null)return{ok:!0,value:void 0};const n=O(e);return n===null?{ok:!1}:{ok:!0,value:n}}function pe(e){if(e===null||typeof e!="object"||Array.isArray(e))return null;const n=e,{p:r,d:o,q:a}=n;return typeof r!="number"||!Number.isInteger(r)||r<0||typeof o!="number"||!Number.isInteger(o)||o<0||typeof a!="number"||!Number.isInteger(a)||a<0?null:{p:r,d:o,q:a}}function _e(e){if(!Array.isArray(e))return null;const n=[];for(const r of e){if(r===null||typeof r!="object")return null;const o=r;if(typeof o.name!="string")return null;const a=v(o.estimate),t=v(o.standardError),s=v(o.zStatistic),l=v(o.pValue);if(a===void 0||t===void 0||s===void 0||l===void 0)return null;n.push({name:o.name,estimate:a,standardError:t,zStatistic:s,pValue:l})}return n}function ve(e){if(e==null)return{ok:!0,value:void 0};if(typeof e!="object"||Array.isArray(e))return{ok:!1};const n=e;if(typeof n.steps!="number"||!Number.isInteger(n.steps)||n.steps<1)return{ok:!1};if(typeof n.confidenceLevel!="number"||!(n.confidenceLevel>0&&n.confidenceLevel<1))return{ok:!1};if(!Array.isArray(n.items))return{ok:!1};const r=[];for(const a of n.items){if(a===null||typeof a!="object")return{ok:!1};const t=a;if(typeof t.step!="number"||!Number.isInteger(t.step)||t.step<1)return{ok:!1};const s=v(t.mean),l=v(t.lower),f=v(t.upper);if(s===void 0||l===void 0||f===void 0)return{ok:!1};let c;if("meanStandardError"in t&&t.meanStandardError!==void 0&&(c=v(t.meanStandardError),c===void 0))return{ok:!1};const u=typeof t.period=="string"&&t.period.trim()!==""?t.period:void 0;r.push({step:t.step,period:u,mean:s,meanStandardError:c,lower:l,upper:f})}const o=Array.isArray(n.warnings)?n.warnings.filter(a=>typeof a=="string"):[];return{ok:!0,value:{steps:n.steps,items:r,confidenceLevel:n.confidenceLevel,warnings:o}}}function ye(e){if(e==null)return{ok:!0,value:void 0};if(typeof e!="object"||Array.isArray(e))return{ok:!1};const n=e,r=pe(n.order);if(r===null)return{ok:!1};const o=_e(n.coefficients);if(o===null)return{ok:!1};const a=v(n.logLikelihood),t=v(n.aic),s=v(n.bic),l=v(n.hqic);if(a===void 0||t===void 0||s===void 0||l===void 0)return{ok:!1};let f;if(n.converged===!0||n.converged===!1)f=n.converged;else if(n.converged!==null&&n.converged!==void 0)return{ok:!1};let c;if(n.nobs!==null&&n.nobs!==void 0){if(typeof n.nobs!="number"||!Number.isInteger(n.nobs)||n.nobs<=0)return{ok:!1};c=n.nobs}const u=Array.isArray(n.warnings)?n.warnings.filter(y=>typeof y=="string"):[],_=ve(n.forecast);if(!_.ok)return{ok:!1};const x=typeof n.forecastError=="string"&&n.forecastError.trim()!==""?n.forecastError:void 0;return{ok:!0,value:{forecast:_.value,forecastError:x,order:r,converged:f,nobs:c,logLikelihood:a,aic:t,bic:s,hqic:l,coefficients:o,warnings:u,interpretation:ce(r,f)}}}function ge(e){if(e==null)return{ok:!0,value:void 0};if(typeof e!="object"||Array.isArray(e))return{ok:!1};const r=O(e.ljungBox);return r===null?{ok:!1}:{ok:!0,value:{ljungBox:r,interpretation:ue(r)}}}function be(e){if(typeof e!="string"||e.trim()==="")return g("El motor Python no devolvió resultados.");let n;try{n=JSON.parse(e)}catch{return g("El motor Python devolvió un resultado ilegible (JSON inválido).")}if(n===null||typeof n!="object"||Array.isArray(n))return g("El motor Python devolvió un resultado con formato inesperado.");const r=n,o=Array.isArray(r.warnings)?r.warnings.filter(y=>typeof y=="string"):[];if(r.ok!==!0){const y=typeof r.error=="string"&&r.error.trim()!==""?r.error:"Error desconocido en el motor Python.";return{ok:!1,engine:"pyodide",warnings:o,error:y}}if(typeof r.variableName!="string"||r.variableName.trim()==="")return g("El motor Python devolvió un nombre de variable inválido.");if(typeof r.observations!="number"||!Number.isInteger(r.observations)||r.observations<=0)return g("El motor Python devolvió un número de observaciones inválido.");let a;if(r.adfRegression!==void 0&&r.adfRegression!==null){if(!F(r.adfRegression))return g("El motor Python devolvió un tipo de regresión ADF inválido.");a=r.adfRegression}let t;if(r.maxLag!==void 0&&r.maxLag!==null){if(typeof r.maxLag!="number"||!Number.isInteger(r.maxLag)||r.maxLag<1)return g("El motor Python devolvió un rezago máximo inválido.");t=r.maxLag}const s=fe(r.adf);if(!s.ok)return g("El motor Python devolvió un test ADF inválido.");let l;if(r.acf!==void 0&&r.acf!==null){const y=z(r.acf);if(y===null)return g("El motor Python devolvió una ACF inválida.");l=y}let f;if(r.pacf!==void 0&&r.pacf!==null){const y=z(r.pacf);if(y===null)return g("El motor Python devolvió una PACF inválida.");f=y}const c=me(r.ljungBox);if(!c.ok)return g("El motor Python devolvió un test Ljung-Box inválido.");const u=ye(r.arima);if(!u.ok)return g("El motor Python devolvió un resultado ARIMA inválido.");const _=ge(r.arimaResidualDiagnostics);if(!_.ok)return g("El motor Python devolvió diagnósticos de residuos ARIMA inválidos.");const x=typeof r.arimaError=="string"&&r.arimaError.trim()!==""?r.arimaError:void 0;return{ok:!0,engine:"pyodide",variableName:r.variableName,observations:r.observations,adfRegression:a,maxLag:t,adf:s.value,acf:l,pacf:f,ljungBox:c.value,arima:u.value,arimaError:x,arimaResidualDiagnostics:_.value,warnings:o}}const M=12,he=40,xe=12;function Ae(e){return Math.max(1,Math.min(he,Math.floor(e/2)-1))}function Ne(e){const n=[],r=(e.variableName??"").trim();if(r==="")return{ok:!1,error:"Seleccioná una columna de serie antes de correr los diagnósticos."};const o=Array.isArray(e.values)||e.values instanceof Float64Array?e.values:[];let a=0;for(const d of o)typeof d=="number"&&Number.isFinite(d)&&a++;const t=new Float64Array(a);let s=0;for(const d of o)typeof d=="number"&&Number.isFinite(d)&&(t[s++]=d);const l=o.length-a;l>0&&n.push(`Se descartaron ${l} observaciones no numéricas, faltantes o infinitas.`);const f=t.length;if(f<M)return{ok:!1,error:`La serie necesita suficientes observaciones válidas para calcular diagnósticos de series de tiempo (al menos ${M}; hay ${f}).`};let c=t[0],u=t[0];for(let d=1;d<t.length;d++)c=Math.min(c,t[d]),u=Math.max(u,t[d]);if(u-c===0)return{ok:!1,error:"La serie es constante; no se pueden calcular ADF/ACF/PACF de forma significativa."};const _=e.adfRegression??ne;if(!F(_))return{ok:!1,error:`Tipo de regresión ADF inválido: "${String(_)}". Valores permitidos: c, ct, ctt, n.`};const x=Ae(f);let m=Number.isInteger(e.maxLag)?e.maxLag:xe;m<1&&(m=1,n.push("El rezago máximo debe ser al menos 1; se usa 1.")),m>x&&(n.push(`El rezago máximo es demasiado alto para la cantidad de observaciones disponibles (máximo razonable ${x}); se usa ${x}.`),m=x);let p;if(Array.isArray(e.ljungBoxLags)&&e.ljungBoxLags.length>0){const d=e.ljungBoxLags;p=Array.from(new Set(d.filter(h=>Number.isInteger(h)&&h>=1&&h<=m))).sort((h,E)=>h-E),p.length<d.length&&n.push(`Se ajustaron los rezagos de Ljung-Box al rango válido 1..${m}.`),p.length===0&&(p=D(1,m),n.push(`Ningún rezago de Ljung-Box era válido; se usa el rango 1..${m}.`))}else p=D(1,m);return{ok:!0,value:{values:t,variableName:r,maxLag:m,adfRegression:_,ljungBoxLags:p,warnings:n}}}function Ee(e,n){if(!e)return{ok:!1,error:"Falta el orden ARIMA (p, d, q) para estimar el modelo."};const{p:r,d:o,q:a}=e;return[r,o,a].every(t=>typeof t=="number"&&Number.isInteger(t))?r<0||o<0||a<0?{ok:!1,error:"Los parámetros p, d y q deben ser enteros no negativos."}:r===0&&o===0&&a===0?{ok:!1,error:"ARIMA(0,0,0) no aporta dinámica temporal. Elegí al menos p, d o q mayor que cero."}:r>q||a>oe||o>T?{ok:!1,error:`Para esta primera versión, usá p y q entre 0 y ${q}, y d entre 0 y ${T}.`}:n-o<r+a+2?{ok:!1,error:"La serie no tiene suficientes observaciones para estimar este ARIMA. Probá un orden más simple."}:{ok:!0,value:{p:r,d:o,q:a}}:{ok:!1,error:"Los parámetros p, d y q deben ser enteros no negativos."}}function ke(e){return e==null?{ok:!1,error:"Falta el horizonte de forecast (cantidad de períodos futuros)."}:typeof e!="number"||!Number.isInteger(e)||e<ae?{ok:!1,error:"El horizonte de forecast debe ser un entero positivo."}:e>C?{ok:!1,error:`Para esta primera versión, usá un horizonte de hasta ${C} períodos.`}:{ok:!0,value:e}}function D(e,n){const r=[];for(let o=e;o<=n;o+=1)r.push(o);return r}const Se=`
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
    # 0 = sin forecast. Sólo se usa si el ARIMA se estimó correctamente.
    forecast_steps = int(chartbay_ts_forecast_steps)

    if adf_regression not in ("c", "ct", "ctt", "n"):
        return fail('Tipo de regresión ADF no soportado: "' + str(adf_regression) + '". Usá c, ct, ctt o n.')

    try:
        arr = np.asarray(chartbay_ts_values, dtype=float)
    except Exception as exc:
        return fail("No se pudieron leer los valores de la serie (" + str(exc) + ").")
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

            # ── Forecast out-of-sample ────────────────────────────────
            # Sólo corre si el ARIMA se estimó bien (estamos dentro del try
            # exitoso) y el usuario pidió un horizonte. Falla de forma
            # controlada: forecastError SIN borrar el resultado ARIMA.
            # summary_frame() puede cambiar los nombres de columnas según la
            # versión de statsmodels — se buscan candidatos y, si faltan, se
            # cae a predicted_mean / conf_int(). Los intervalos NUNCA se
            # inventan: si no están disponibles, quedan en null con warning.
            if forecast_steps > 0:
                try:
                    fc_warnings = []
                    forecast_res = fit.get_forecast(steps=forecast_steps)
                    frame = None
                    try:
                        frame = forecast_res.summary_frame(alpha=0.05)
                    except Exception:
                        frame = None

                    def pick_col(candidates):
                        if frame is None:
                            return None
                        for c in candidates:
                            if c in list(frame.columns):
                                return [v for v in frame[c]]
                        return None

                    mean_vals = pick_col(["mean", "predicted_mean"])
                    se_vals = pick_col(["mean_se", "se_mean"])
                    lo_vals = pick_col(["mean_ci_lower", "lower"])
                    hi_vals = pick_col(["mean_ci_upper", "upper"])

                    if mean_vals is None:
                        mean_vals = [v for v in np.asarray(forecast_res.predicted_mean, dtype=float)]
                    if lo_vals is None or hi_vals is None:
                        try:
                            ci = np.asarray(forecast_res.conf_int(alpha=0.05), dtype=float)
                            if ci.ndim == 2 and ci.shape[1] >= 2:
                                lo_vals = [v for v in ci[:, 0]]
                                hi_vals = [v for v in ci[:, 1]]
                        except Exception:
                            pass
                    if lo_vals is None or hi_vals is None:
                        lo_vals = [None] * forecast_steps
                        hi_vals = [None] * forecast_steps
                        fc_warnings.append(
                            "statsmodels no devolvió intervalos de confianza para este forecast; "
                            "se muestran sólo los pronósticos puntuales."
                        )

                    items = []
                    for i in range(forecast_steps):
                        items.append({
                            "step": i + 1,
                            "mean": finite_or_none(mean_vals[i]) if i < len(mean_vals) else None,
                            "meanStandardError": (
                                finite_or_none(se_vals[i]) if (se_vals is not None and i < len(se_vals)) else None
                            ),
                            "lower": finite_or_none(lo_vals[i]) if i < len(lo_vals) else None,
                            "upper": finite_or_none(hi_vals[i]) if i < len(hi_vals) else None,
                        })
                    result["arima"]["forecast"] = {
                        "steps": forecast_steps,
                        "items": items,
                        "confidenceLevel": 0.95,
                        "warnings": fc_warnings,
                    }
                except Exception as exc:
                    result["arima"]["forecastError"] = (
                        "No se pudo calcular el forecast para este modelo. El ARIMA fue estimado, "
                        "pero statsmodels no pudo generar predicciones futuras. (" + str(exc) + ")"
                    )
        except Exception as exc:
            result["arima"] = None
            result["arimaError"] = (
                "No se pudo estimar ARIMA con este orden. Probá un modelo más simple o revisá si la serie "
                "tiene suficientes observaciones. (" + str(exc) + ")"
            )

    return result


json.dumps(_chartbay_pro_time_series())
`;function V(e){return e instanceof Error?e.message:String(e)}async function je(e,n){const r=Ne(e);if(!r.ok)return g(r.error);const{values:o,variableName:a,maxLag:t,adfRegression:s,ljungBoxLags:l,warnings:f}=r.value;let c=!1,u=null,_=null;if(e.runArima){const p=Ee(e.arimaOrder,o.length);p.ok?(c=!0,u=p.value):_=p.error}let x=0,y=null;if(c&&e.forecastSteps!==void 0){const p=ke(e.forecastSteps);p.ok?x=p.value:y=p.error}let m;try{m=await R(n)}catch(p){return g(`No se pudo cargar Pyodide (Python en el navegador): ${V(p)}`)}try{n==null||n("running"),m.globals.set("chartbay_ts_name",a),m.globals.set("chartbay_ts_values",o),m.globals.set("chartbay_ts_max_lag",t),m.globals.set("chartbay_ts_adf_regression",s),m.globals.set("chartbay_ts_ljung_box_lags_json",JSON.stringify(l)),m.globals.set("chartbay_ts_run_arima",c),m.globals.set("chartbay_ts_arima_order_json",JSON.stringify(u??{p:0,d:0,q:0})),m.globals.set("chartbay_ts_forecast_steps",x);const p=await m.runPythonAsync(Se),d=be(p);if(!d.ok)return d;const h=f.length>0?{...d,warnings:[...f,...d.warnings]}:d;return _&&(h.arimaError=_),y&&h.arima&&(h.arima={...h.arima,forecastError:y}),h}catch(p){return g(`Error ejecutando diagnósticos de series de tiempo con statsmodels en Python: ${V(p)}`)}}function A(e){postMessage(e)}async function Pe(e){try{if(e.kind==="warmup"){await R(r=>{A({id:e.id,kind:"phase",phase:r})}),A({id:e.id,kind:"warmup-result",result:{ok:!0}});return}if(e.kind==="ols"){const r=await re(e.input,o=>{A({id:e.id,kind:"phase",phase:o})});A({id:e.id,kind:"ols-result",result:r});return}const n=await je(e.input,r=>{A({id:e.id,kind:"phase",phase:r})});A({id:e.id,kind:"timeseries-result",result:n})}catch(n){const r=n instanceof Error?n.message:String(n);e.kind==="warmup"?A({id:e.id,kind:"warmup-result",result:{ok:!1,error:r}}):e.kind==="ols"?A({id:e.id,kind:"ols-result",result:i(`El worker de Pro falló: ${r}`)}):A({id:e.id,kind:"timeseries-result",result:g(`El worker de Pro falló: ${r}`)})}}let B=Promise.resolve();self.onmessage=e=>{const n=e.data;B=B.then(()=>Pe(n))}})();
