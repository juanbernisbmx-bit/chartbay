import type {
  ReproducibilityAction,
  ReproducibilityLanguage,
  ReproducibilitySpec,
  ReproducibilityTimeSeriesSpec,
} from './types';

export const REPRODUCIBILITY_LANGUAGE_META: Record<
  ReproducibilityLanguage,
  { label: string; extension: string; mime: string }
> = {
  r: { label: 'R', extension: 'R', mime: 'text/x-r-source' },
  python: { label: 'Python', extension: 'py', mime: 'text/x-python' },
  stata: { label: 'Stata', extension: 'do', mime: 'text/plain' },
  notebook: { label: 'Notebook', extension: 'ipynb', mime: 'application/x-ipynb+json' },
};

function json(value: unknown): string {
  return JSON.stringify(value);
}

function pyString(value: string): string {
  return json(value);
}

function rString(value: string): string {
  return json(value);
}

function stataString(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rName(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

function stataName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 32) || 'variable';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stataRestrictionExpression(
  expression: string,
  xNames: string[],
  coefficientNames: string[] = xNames.map(stataName)
): string {
  let rendered = expression;
  const names = [...xNames].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const token = `(?:beta_)?${escapeRegExp(name)}`;
    rendered = rendered.replace(new RegExp(`(^|[^a-zA-Z0-9_])(${token})(?=$|[^a-zA-Z0-9_])`, 'g'), (_match, prefix) => {
      const index = xNames.indexOf(name);
      return `${prefix}_b[${coefficientNames[index] ?? stataName(name)}]`;
    });
  }
  return rendered;
}

function stataConstraintExpression(
  expression: string,
  xNames: string[],
  coefficientNames: string[] = xNames.map(stataName)
): string {
  let rendered = expression;
  const names = [...xNames].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const token = `(?:beta_)?${escapeRegExp(name)}`;
    rendered = rendered.replace(new RegExp(`(^|[^a-zA-Z0-9_])(${token})(?=$|[^a-zA-Z0-9_])`, 'g'), (_match, prefix) => {
      const index = xNames.indexOf(name);
      return `${prefix}${coefficientNames[index] ?? stataName(name)}`;
    });
  }
  return rendered;
}

function numericMatrix(matrix: number[][]): string {
  return json(matrix);
}

function regressionPython(spec: ReproducibilitySpec): string {
  const r = spec.regression;
  const liteRls = spec.engine === 'lite' && r.restriction !== null;
  const logY = r.functionalForm === 'log-lin' || r.functionalForm === 'log-log';
  const logX = r.functionalForm === 'lin-log' || r.functionalForm === 'log-log';
  const dummyNames = r.categoricalEncodings.flatMap(item => item.dummyNames);
  const categorical = json(r.categoricalEncodings);
  const robust = r.standardErrorType === 'classic'
    ? 'results = model.fit()'
    : r.standardErrorType === 'HAC'
      ? `hac_lags_requested = ${r.hacMaxLags ?? 'None'}
hac_lags = int(4 * (len(model_data) / 100) ** (2 / 9)) if hac_lags_requested is None else int(hac_lags_requested)
hac_lags_used = max(0, min(hac_lags, len(model_data) - 1))
results = model.fit(cov_type="HAC", cov_kwds={"maxlags": hac_lags_used})`
      : `results = model.fit(cov_type=${pyString(r.standardErrorType)})`;
  const missing = r.dropIncompleteRows
    ? 'model_data = model_data.dropna().copy()'
    : [
        'if model_data.isna().to_numpy().any():',
        '    raise ValueError("ChartBay no ejecutó el modelo: hay datos faltantes y listwise no estaba activado.")',
      ].join('\n');
  const proRestriction = r.restriction && spec.engine === 'pro'
    ? [
          '',
          `R = np.asarray(${numericMatrix(r.restriction.R)}, dtype=float)`,
          `q = np.asarray(${json(r.restriction.q)}, dtype=float)`,
          'print("Test de restricción ChartBay Pro:")',
          'print(results.f_test((R, q)))',
      ].join('\n')
    : '';
  const estimation = liteRls
    ? `unrestricted_results = model.fit()
X_matrix = X.to_numpy(dtype=float)
y_values = y.to_numpy(dtype=float)
R = np.asarray(${numericMatrix(r.restriction!.R)}, dtype=float)
q = np.asarray(${json(r.restriction!.q)}, dtype=float)

# RLS de ChartBay Lite: beta_R = beta_OLS - (X'X)^-1 R' [R(X'X)^-1R']^-1 (R beta_OLS - q)
xtx_inv = np.linalg.inv(X_matrix.T @ X_matrix)
restriction_middle_inv = np.linalg.inv(R @ xtx_inv @ R.T)
beta_ols = np.asarray(unrestricted_results.params, dtype=float)
beta_restricted = beta_ols - xtx_inv @ R.T @ restriction_middle_inv @ (R @ beta_ols - q)
predictions = X_matrix @ beta_restricted
residuals = y_values - predictions

nobs, parameter_count = X_matrix.shape
df_resid = nobs - parameter_count
rss_ols = float(np.sum(np.asarray(unrestricted_results.resid) ** 2))
rss_restricted = float(residuals @ residuals)
ss_total = float(np.sum((y_values - y_values.mean()) ** 2))
r_squared = 0.0 if ss_total == 0 else 1.0 - rss_restricted / ss_total
adjusted_r_squared = np.nan if df_resid <= 0 else 1.0 - (1.0 - r_squared) * (nobs - 1) / df_resid
sigma2 = np.nan if df_resid <= 0 else rss_restricted / df_resid
overall_f = np.nan if parameter_count <= 1 or df_resid <= 0 else (r_squared / (parameter_count - 1)) / ((1.0 - r_squared) / df_resid)
restriction_f = 0.0 if df_resid <= 0 or rss_ols <= 1e-15 else ((rss_restricted - rss_ols) / R.shape[0]) / (rss_ols / df_resid)

cov_projection = xtx_inv - xtx_inv @ R.T @ restriction_middle_inv @ R @ xtx_inv
cov_restricted = (rss_ols / df_resid) * cov_projection if df_resid > 0 else np.full_like(cov_projection, np.nan)
standard_errors = np.sqrt(np.maximum(0.0, np.diag(cov_restricted)))
t_statistics = np.empty_like(beta_restricted)
has_standard_error = standard_errors > 1e-15
np.divide(beta_restricted, standard_errors, out=t_statistics, where=has_standard_error)
t_statistics[~has_standard_error] = 0.0
zero_se_nonzero_beta = (~has_standard_error) & (beta_restricted != 0.0)
t_statistics[zero_se_nonzero_beta] = np.copysign(np.inf, beta_restricted[zero_se_nonzero_beta])
p_values = 2.0 * stats.t.sf(np.abs(t_statistics), df_resid) if df_resid > 0 else np.full_like(beta_restricted, np.nan)
t_critical = stats.t.ppf(0.975, df_resid) if df_resid > 0 else np.nan
confidence_95 = np.column_stack((beta_restricted - t_critical * standard_errors, beta_restricted + t_critical * standard_errors))

print({
    "method": "RLS",
    "coefficients": dict(zip(X.columns, beta_restricted)),
    "standard_errors": dict(zip(X.columns, standard_errors)),
    "t_statistics": dict(zip(X.columns, t_statistics)),
    "p_values": dict(zip(X.columns, p_values)),
    "confidence_95": dict(zip(X.columns, confidence_95.tolist())),
    "r_squared": r_squared,
    "adjusted_r_squared": adjusted_r_squared,
    "sigma2": sigma2,
    "overall_f": overall_f,
    "restriction_f": restriction_f,
    "rss_ols": rss_ols,
    "rss_rls": rss_restricted,
})`
    : `${robust}
print(results.summary())`;
  const diagnosticResiduals = liteRls ? 'residuals' : 'results.resid';
  const diagnosticExog = liteRls ? 'X_matrix' : 'results.model.exog';

  return `# Generado por ChartBay · receta reproducible v1
# Motor seleccionado: ${spec.engine === 'pro' ? 'Pro (statsmodels/Pyodide)' : 'Lite (TypeScript)'}
# Dataset esperado en el mismo directorio que este script.
from pathlib import Path
import numpy as np
import pandas as pd
import statsmodels
import statsmodels.api as sm
${liteRls ? 'from scipy import stats\n' : ''}from statsmodels.stats.diagnostic import het_breuschpagan
from statsmodels.stats.diagnostic import het_breuschpagan

DATA_FILE = Path(${pyString(spec.datasetName)})
Y_NAME = ${pyString(r.yName)}
X_NAMES = ${json(r.xNames)}
EXPANDED_X_NAMES = ${json(r.expandedXNames)}
DUMMY_NAMES = set(${json(dummyNames)})
CATEGORICAL_ENCODINGS = ${categorical}

df = pd.read_csv(DATA_FILE)
for encoding in CATEGORICAL_ENCODINGS:
    source = encoding["source"]
    labels = df[source].fillna("Sin_dato").astype(str).str.strip()
    for category, dummy in zip(encoding["categories"][1:], encoding["dummyNames"]):
        df[dummy] = (labels == category).astype(float)

model_data = df[[Y_NAME, *EXPANDED_X_NAMES]].apply(pd.to_numeric, errors="coerce")
${missing}

y = model_data[Y_NAME].astype(float)
if ${logY ? 'True' : 'False'}:
    if (y <= 0).any():
        raise ValueError("La forma ${r.functionalForm} requiere Y > 0.")
    y = np.log(y)

X = model_data[EXPANDED_X_NAMES].astype(float).copy()
if ${logX ? 'True' : 'False'}:
    for column in EXPANDED_X_NAMES:
        if column not in DUMMY_NAMES:
            if (X[column] <= 0).any():
                raise ValueError(f"La forma ${r.functionalForm} requiere {column} > 0.")
            X[column] = np.log(X[column])
X = sm.add_constant(X, has_constant="add")

model = sm.OLS(y, X)
${estimation}
print({"numpy": np.__version__, "pandas": pd.__version__, "statsmodels": statsmodels.__version__})

bp_lm, bp_pvalue, bp_f, bp_f_pvalue = het_breuschpagan(${diagnosticResiduals}, ${diagnosticExog})
print({"breusch_pagan_lm": bp_lm, "p_value": bp_pvalue})${proRestriction}
`;
}

function regressionR(spec: ReproducibilitySpec): string {
  const r = spec.regression;
  const liteRls = spec.engine === 'lite' && r.restriction !== null;
  const variables = [r.yName, ...r.expandedXNames].map(rString).join(', ');
  const logY = r.functionalForm === 'log-lin' || r.functionalForm === 'log-log';
  const logX = r.functionalForm === 'lin-log' || r.functionalForm === 'log-log';
  const dummyNames = new Set(r.categoricalEncodings.flatMap(item => item.dummyNames));
  const xExpressions = r.expandedXNames.map(name => logX && !dummyNames.has(name)
    ? `log(${rName(name)})`
    : rName(name));
  const yExpression = logY ? `log(${rName(r.yName)})` : rName(r.yName);
  const encodings = r.categoricalEncodings.flatMap(encoding =>
    encoding.categories.slice(1).map((category, index) =>
      `data[[${rString(encoding.dummyNames[index])}]] <- as.numeric(labels_${stataName(encoding.source)} == ${rString(category)})`
    ).concat([
      `# Categoría base de ${encoding.source}: ${encoding.baseCategory}`,
    ])
  ).join('\n');
  const labels = r.categoricalEncodings.map(encoding =>
    `labels_${stataName(encoding.source)} <- trimws(ifelse(is.na(data[[${rString(encoding.source)}]]), "Sin_dato", as.character(data[[${rString(encoding.source)}]])))`
  ).join('\n');
  const missing = r.dropIncompleteRows
    ? 'model_data <- na.omit(model_data)'
    : 'if (anyNA(model_data)) stop("Hay datos faltantes y listwise no estaba activado en ChartBay.")';
  const robust = r.standardErrorType === 'classic'
    ? ''
    : r.standardErrorType === 'HAC'
      ? `
if (!requireNamespace("sandwich", quietly = TRUE) || !requireNamespace("lmtest", quietly = TRUE)) {
  stop("Instalá sandwich y lmtest para reproducir errores HAC.")
}
chartbay_hac_lags <- ${r.hacMaxLags ?? 'floor(4 * (nobs(fit) / 100)^(2 / 9))'}
chartbay_hac_lags <- max(0, min(as.integer(chartbay_hac_lags), nobs(fit) - 1))
chartbay_vcov <- sandwich::NeweyWest(fit, lag = chartbay_hac_lags, prewhite = FALSE)
print(lmtest::coeftest(fit, vcov. = chartbay_vcov))`
      : `
if (!requireNamespace("sandwich", quietly = TRUE) || !requireNamespace("lmtest", quietly = TRUE)) {
  stop("Instalá sandwich y lmtest para reproducir errores ${r.standardErrorType}.")
}
chartbay_vcov <- sandwich::vcovHC(fit, type = "${r.standardErrorType}")
print(lmtest::coeftest(fit, vcov. = chartbay_vcov))`;
  const restriction = r.restriction
    ? [
        '',
        `R <- matrix(c(${r.restriction.R.flat().join(', ')}), nrow = ${r.restriction.R.length}, byrow = TRUE)`,
        `q <- c(${r.restriction.q.join(', ')})`,
        liteRls
          ? [
              "X_matrix <- model.matrix(fit)",
              "y_vector <- model.response(model.frame(fit))",
              "beta_ols <- coef(fit)",
              "xtx_inv <- solve(crossprod(X_matrix))",
              "restriction_middle_inv <- solve(R %*% xtx_inv %*% t(R))",
              "beta_restricted <- drop(beta_ols - xtx_inv %*% t(R) %*% restriction_middle_inv %*% (R %*% beta_ols - q))",
              "names(beta_restricted) <- colnames(X_matrix)",
              "predictions_restricted <- drop(X_matrix %*% beta_restricted)",
              "residuals_restricted <- y_vector - predictions_restricted",
              "nobs_chartbay <- length(y_vector)",
              "parameter_count <- ncol(X_matrix)",
              "df_resid <- nobs_chartbay - parameter_count",
              "rss_ols <- sum(residuals(fit)^2)",
              "rss_restricted <- sum(residuals_restricted^2)",
              "ss_total <- sum((y_vector - mean(y_vector))^2)",
              "r_squared <- if (ss_total == 0) 0 else 1 - rss_restricted / ss_total",
              "adjusted_r_squared <- if (df_resid > 0) 1 - (1 - r_squared) * (nobs_chartbay - 1) / df_resid else NaN",
              "sigma2 <- if (df_resid > 0) rss_restricted / df_resid else NaN",
              "overall_f <- if (parameter_count > 1 && df_resid > 0) (r_squared / (parameter_count - 1)) / ((1 - r_squared) / df_resid) else NaN",
              "restriction_f <- if (df_resid > 0 && rss_ols > 1e-15) ((rss_restricted - rss_ols) / nrow(R)) / (rss_ols / df_resid) else 0",
              "cov_projection <- xtx_inv - xtx_inv %*% t(R) %*% restriction_middle_inv %*% R %*% xtx_inv",
              "cov_restricted <- if (df_resid > 0) (rss_ols / df_resid) * cov_projection else matrix(NaN, parameter_count, parameter_count)",
              "standard_errors <- sqrt(pmax(0, diag(cov_restricted)))",
              "t_statistics <- ifelse(standard_errors > 1e-15, beta_restricted / standard_errors, ifelse(beta_restricted == 0, 0, sign(beta_restricted) * Inf))",
              "p_values <- if (df_resid > 0) 2 * pt(abs(t_statistics), df = df_resid, lower.tail = FALSE) else rep(NaN, parameter_count)",
              "t_critical <- if (df_resid > 0) qt(0.975, df = df_resid) else NaN",
              "confidence_95 <- cbind(beta_restricted - t_critical * standard_errors, beta_restricted + t_critical * standard_errors)",
              "print(data.frame(coefficient = beta_restricted, standard_error = standard_errors, t = t_statistics, p_value = p_values, ci_low = confidence_95[, 1], ci_high = confidence_95[, 2]))",
              "print(list(method = \"RLS\", r_squared = r_squared, adjusted_r_squared = adjusted_r_squared, sigma2 = sigma2, overall_f = overall_f, restriction_f = restriction_f, rss_ols = rss_ols, rss_rls = rss_restricted))",
            ].join('\n')
          : [
              '# Test de Wald/F equivalente a ChartBay Pro.',
              'if (!requireNamespace("car", quietly = TRUE)) stop("Instalá el paquete car para ejecutar la restricción Pro.")',
              `print(car::linearHypothesis(fit, hypothesis.matrix = R, rhs = q${r.standardErrorType === 'classic' ? '' : ', vcov. = chartbay_vcov'}))`,
            ].join('\n'),
      ].join('\n')
    : '';
  const diagnostics = liteRls
    ? `
residuals_squared <- residuals_restricted^2
bp_fit <- lm.fit(x = X_matrix, y = residuals_squared)
bp_total <- sum((residuals_squared - mean(residuals_squared))^2)
bp_r_squared <- if (bp_total == 0) 0 else 1 - sum(bp_fit$residuals^2) / bp_total
bp_lm <- nobs_chartbay * bp_r_squared
bp_df <- parameter_count - 1
print(list(test = "Breusch-Pagan", statistic = bp_lm, df = bp_df, p_value = pchisq(bp_lm, df = bp_df, lower.tail = FALSE)))`
    : `
if (!requireNamespace("lmtest", quietly = TRUE)) {
  message("Breusch-Pagan omitido: instalá el paquete lmtest para reproducir ese diagnóstico.")
} else {
  print(lmtest::bptest(fit))
}`;

  return `# Generado por ChartBay · receta reproducible v1
# Paquetes base de R; "lmtest" se usa únicamente para Breusch-Pagan.
data_file <- ${rString(spec.datasetName)}
data <- read.csv(data_file, check.names = FALSE, stringsAsFactors = FALSE)
${labels}${labels && encodings ? '\n' : ''}${encodings}

model_data <- data[c(${variables})]
${missing}
formula_chartbay <- ${yExpression} ~ ${xExpressions.length ? xExpressions.join(' + ') : '1'}
fit <- lm(formula_chartbay, data = model_data)
${liteRls ? '# El resumen se calcula con los coeficientes RLS, no con el OLS irrestricto.' : 'print(summary(fit))'}
${robust}
${restriction}${diagnostics}
sessionInfo()
`;
}

function regressionStata(spec: ReproducibilitySpec): string {
  const r = spec.regression;
  const liteRls = spec.engine === 'lite' && r.restriction !== null;
  const logY = r.functionalForm === 'log-lin' || r.functionalForm === 'log-log';
  const logX = r.functionalForm === 'lin-log' || r.functionalForm === 'log-log';
  const dummyNames = new Set(r.categoricalEncodings.flatMap(item => item.dummyNames));
  const categorical = r.categoricalEncodings.flatMap(encoding =>
    encoding.categories.slice(1).map((category, index) => {
      const source = stataName(encoding.source);
      const target = stataName(encoding.dummyNames[index]);
      return category === 'Sin_dato'
        ? `generate byte ${target} = missing(${source})`
        : `generate byte ${target} = trim(${source}) == ${stataString(category)}`;
    })
  ).join('\n');
  const y = stataName(r.yName);
  const transformedY = logY ? '_cb_y' : y;
  const generatedX: string[] = [];
  const modelX = r.expandedXNames.map((name, index) => {
    const safe = stataName(name);
    if (!logX || dummyNames.has(name)) return safe;
    const transformed = `_cb_x${index + 1}`;
    generatedX.push(`assert ${safe} > 0 if !missing(${safe})\ngenerate double ${transformed} = ln(${safe})`);
    return transformed;
  });
  const selected = [y, ...r.xNames.map(stataName)].join(' ');
  const missing = r.dropIncompleteRows
    ? `drop if missing(${[y, ...r.expandedXNames.map(stataName)].join(', ')})`
    : `assert !missing(${[y, ...r.expandedXNames.map(stataName)].join(', ')})`;
  const stataHacLags = r.hacMaxLags === null
    ? 'local _cb_hac_lags = floor(4 * (e(N) / 100)^(2 / 9))'
    : `local _cb_hac_lags = ${r.hacMaxLags}`;
  const regularEstimate = r.standardErrorType === 'HAC'
    ? `regress ${transformedY} ${modelX.join(' ')}\nestat hettest\n${stataHacLags}\nlocal _cb_hac_lags = max(0, min(\`_cb_hac_lags', e(N) - 1))\nnewey ${transformedY} ${modelX.join(' ')}, lag(\`_cb_hac_lags')`
    : `regress ${transformedY} ${modelX.join(' ')}${r.standardErrorType === 'classic' ? '' : r.standardErrorType === 'HC3' ? ', vce(hc3)' : ', vce(robust)'}\nestat hettest`;
  const liteRestrictedEstimate = r.restriction && liteRls
    ? `quietly regress ${transformedY} ${modelX.join(' ')}
scalar _cb_rss_ols = e(rss)
scalar _cb_df_resid = e(df_r)
constraint define 1 ${stataConstraintExpression(r.restriction.expression, r.expandedXNames, modelX)}
cnsreg ${transformedY} ${modelX.join(' ')}, constraints(1)
scalar _cb_rss_rls = e(rss)
scalar _cb_restriction_f = 0
if _cb_df_resid > 0 & _cb_rss_ols > 1e-15 scalar _cb_restriction_f = ((_cb_rss_rls - _cb_rss_ols) / ${r.restriction.R.length}) / (_cb_rss_ols / _cb_df_resid)
display "F de la restricción RLS = " _cb_restriction_f
predict double _cb_residual, residuals
generate double _cb_residual_sq = _cb_residual^2
quietly regress _cb_residual_sq ${modelX.join(' ')}
scalar _cb_bp_lm = e(N) * e(r2)
display "Breusch-Pagan LM = " _cb_bp_lm "  p-value = " chi2tail(e(df_m), _cb_bp_lm)`
    : '';
  const proRestriction = r.restriction && spec.engine === 'pro'
    ? `\ntestnl (${stataRestrictionExpression(r.restriction.expression, r.expandedXNames, modelX)})`
    : '';

  return `* Generado por ChartBay · receta reproducible v1
version 18
clear all
set more off
import delimited using ${stataString(spec.datasetName)}, varnames(1) clear
keep ${selected}
${categorical}
${missing}
${logY ? `assert ${y} > 0\ngenerate double _cb_y = ln(${y})` : ''}
${generatedX.join('\n')}
${liteRls ? liteRestrictedEstimate : regularEstimate}${proRestriction}
`;
}

function transformationPython(ts: ReproducibilityTimeSeriesSpec): string {
  switch (ts.transformation) {
    case 'difference': return 'series = series.diff().dropna()';
    case 'percentReturn': return 'series = series.pct_change(fill_method=None).mul(100).dropna()';
    case 'logReturn': return 'series = np.log(series).diff().dropna()';
    case 'base100': return 'series = series.div(series.iloc[0]).mul(100)';
    case 'movingAverage': return `series = series.rolling(${ts.movingAverageWindow}).mean().dropna()`;
    default: return '# Se conserva la serie original.';
  }
}

function timeSeriesPython(spec: ReproducibilitySpec): string {
  const ts = spec.timeSeries;
  const date = ts.dateColumn
    ? `df[${pyString(ts.dateColumn)}] = pd.to_datetime(df[${pyString(ts.dateColumn)}], errors="raise")
df = df.sort_values(${pyString(ts.dateColumn)}).set_index(${pyString(ts.dateColumn)})`
    : '# ChartBay Pro fue ejecutado sin columna temporal.';
  const temporalIndex = ts.dateColumn
    ? `
try:
    inferred_frequency = pd.infer_freq(series.index)
except ValueError:
    inferred_frequency = None
if inferred_frequency:
    series.index = pd.DatetimeIndex(series.index, freq=inferred_frequency)
else:
    print("Aviso: frecuencia temporal irregular; el forecast se identificará como t+1, t+2, ...")`
    : '';
  const arima = ts.runArima
    ? `\nfrom statsmodels.tsa.arima.model import ARIMA\narima = ARIMA(series, order=(${ts.arimaOrder.p}, ${ts.arimaOrder.d}, ${ts.arimaOrder.q})).fit()\nprint(arima.summary())\nprint(arima.get_forecast(steps=${ts.forecastSteps}).summary_frame())`
    : '';
  return `# Generado por ChartBay · receta reproducible v1
from pathlib import Path
import numpy as np
import pandas as pd
from statsmodels.tsa.stattools import acf, pacf, adfuller
from statsmodels.stats.diagnostic import acorr_ljungbox

df = pd.read_csv(Path(${pyString(spec.datasetName)}))
${date}
series = pd.to_numeric(df[${pyString(ts.valueColumn)}], errors="coerce").dropna()
${temporalIndex}
${transformationPython(ts)}

print("ADF:", adfuller(series, maxlag=${ts.maxLag}, regression=${pyString(ts.adfRegression)}, autolag="AIC"))
print("ACF:", acf(series, nlags=${ts.maxLag}, fft=False))
print("PACF:", pacf(series, nlags=${ts.maxLag}, method="ywm"))
print("Ljung-Box:")
print(acorr_ljungbox(series, lags=[min(${ts.maxLag}, max(1, len(series) // 5))], return_df=True))${arima}
`;
}

function timeSeriesR(spec: ReproducibilitySpec): string {
  const ts = spec.timeSeries;
  const transform: Record<ReproducibilityTimeSeriesSpec['transformation'], string> = {
    original: '# Se conserva la serie original.',
    difference: 'series <- diff(series)',
    percentReturn: 'series <- 100 * diff(series) / head(series, -1)',
    logReturn: 'series <- diff(log(series))',
    base100: 'series <- 100 * series / series[1]',
    movingAverage: `series <- as.numeric(stats::filter(series, rep(1 / ${ts.movingAverageWindow}, ${ts.movingAverageWindow}), sides = 1))\nseries <- series[is.finite(series)]`,
  };
  const order = ts.dateColumn
    ? `dates <- as.Date(data[[${rString(ts.dateColumn)}]])\ndata <- data[order(dates), ]`
    : '# Sin columna temporal: se preserva el orden de las filas.';
  const arima = ts.runArima
    ? `\nfit_arima <- arima(series, order = c(${ts.arimaOrder.p}, ${ts.arimaOrder.d}, ${ts.arimaOrder.q}))\nprint(fit_arima)\nprint(predict(fit_arima, n.ahead = ${ts.forecastSteps}))`
    : '';
  return `# Generado por ChartBay · receta reproducible v1
data <- read.csv(${rString(spec.datasetName)}, check.names = FALSE)
${order}
series <- as.numeric(data[[${rString(ts.valueColumn)}]])
series <- series[is.finite(series)]
${transform[ts.transformation]}

acf(series, lag.max = ${ts.maxLag}, plot = FALSE)
pacf(series, lag.max = ${ts.maxLag}, plot = FALSE)
print(Box.test(series, lag = min(${ts.maxLag}, floor(length(series) / 5)), type = "Ljung-Box"))
if (!requireNamespace("urca", quietly = TRUE)) stop("Instalá el paquete urca para reproducir ADF.")
print(summary(urca::ur.df(series, type = ${rString(ts.adfRegression === 'n' ? 'none' : ts.adfRegression === 'c' ? 'drift' : 'trend')}, lags = ${ts.maxLag}, selectlags = "AIC")))${arima}
`;
}

function timeSeriesStata(spec: ReproducibilitySpec): string {
  const ts = spec.timeSeries;
  const value = stataName(ts.valueColumn);
  const transform: Record<ReproducibilityTimeSeriesSpec['transformation'], string> = {
    original: `generate double _cb_series = ${value}`,
    difference: `generate double _cb_series = D.${value}`,
    percentReturn: `generate double _cb_series = 100 * D.${value} / L.${value}`,
    logReturn: `assert ${value} > 0 if !missing(${value})\ngenerate double _cb_log = ln(${value})\ngenerate double _cb_series = D._cb_log`,
    base100: `generate double _cb_series = 100 * ${value} / ${value}[1]`,
    movingAverage: `tssmooth ma _cb_series = ${value}, window(${ts.movingAverageWindow - 1} 1 0)`,
  };
  const arima = ts.runArima
    ? `\narima _cb_series, arima(${ts.arimaOrder.p},${ts.arimaOrder.d},${ts.arimaOrder.q})\nlocal _cb_forecast_start = _cb_t[_N] + 1\ntsappend, add(${ts.forecastSteps})\npredict double _cb_forecast, y dynamic(\`_cb_forecast_start')`
    : '';
  return `* Generado por ChartBay · receta reproducible v1
version 18
clear all
set more off
import delimited using ${stataString(spec.datasetName)}, varnames(1) clear
${ts.dateColumn ? `sort ${stataName(ts.dateColumn)}` : '* Sin columna temporal: se preserva el orden de las filas.'}
generate long _cb_t = _n
tsset _cb_t
${transform[ts.transformation]}
drop if missing(_cb_series)
corrgram _cb_series, lags(${ts.maxLag})
dfuller _cb_series, lags(${ts.maxLag})${arima}
`;
}

export function generatePlainScript(
  spec: ReproducibilitySpec,
  language: Exclude<ReproducibilityLanguage, 'notebook'>
): string {
  if (spec.mode === 'timeseries') {
    if (language === 'r') return timeSeriesR(spec);
    if (language === 'stata') return timeSeriesStata(spec);
    return timeSeriesPython(spec);
  }
  if (language === 'r') return regressionR(spec);
  if (language === 'stata') return regressionStata(spec);
  return regressionPython(spec);
}

export function generateNotebook(spec: ReproducibilitySpec): string {
  const source = generatePlainScript(spec, 'python').split(/(?<=\n)/);
  const notebook = {
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: [
          '# Análisis reproducible de ChartBay\n',
          `Motor original: **${spec.engine}** · modo: **${spec.mode}**.\n`,
          `Dataset esperado: \`${spec.datasetName}\`.\n`,
        ],
      },
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source },
    ],
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3' },
      chartbay: { schemaVersion: spec.schemaVersion, generatedAt: spec.generatedAt },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(notebook, null, 2) + '\n';
}

export function generateReproducibilityArtifact(
  spec: ReproducibilitySpec,
  language: ReproducibilityLanguage
): string {
  return language === 'notebook' ? generateNotebook(spec) : generatePlainScript(spec, language);
}

export function generateActionSnippet(
  action: ReproducibilityAction,
  language: ReproducibilityLanguage
): string {
  const spec = action.spec;
  const effectiveLanguage = language === 'notebook' ? 'python' : language;
  if (spec.mode === 'timeseries') {
    const ts = spec.timeSeries;
    if (effectiveLanguage === 'r') {
      return `# ${action.label}\nseries <- data[[${rString(ts.valueColumn)}]]`;
    }
    if (effectiveLanguage === 'stata') {
      return `* ${action.label}\ncorrgram ${stataName(ts.valueColumn)}, lags(${ts.maxLag})`;
    }
    return `# ${action.label}\nseries = df[${pyString(ts.valueColumn)}]`;
  }

  const regression = spec.regression;
  if (effectiveLanguage === 'r') {
    return `# ${action.label}\nfit <- lm(${rName(regression.yName)} ~ ${regression.xNames.map(rName).join(' + ') || '1'}, data = model_data)`;
  }
  if (effectiveLanguage === 'stata') {
    return `* ${action.label}\nregress ${stataName(regression.yName)} ${regression.xNames.map(stataName).join(' ')}`;
  }
  return `# ${action.label}\ny_name = ${pyString(regression.yName)}; x_names = ${json(regression.xNames)}`;
}
