// Exportación de resultados de ChartBay Pro (regresión y series de tiempo) a
// Markdown, TXT y CSV. Este módulo es PURO: sólo construye strings a partir de
// los resultados ya normalizados (PyodideOlsResult / PyodideTimeSeriesResult).
// No toca el DOM, no descarga archivos y no inventa valores faltantes: los
// bloques inexistentes se omiten o se marcan como no disponibles.
//
// Convenciones de formato:
//   - Markdown / TXT: un valor nulo o no finito se muestra como "N/D".
//   - CSV: un valor nulo o no finito se emite como campo vacío (nunca NaN ni
//     Infinity), respetando el escaping de csvCell (fuente de verdad única).

import { csvCell } from '../ui/exports';
import { FORM_LABELS } from '../ui/formRecommendView';
import { BREUSCH_PAGAN_NOTE } from '../heteroskedasticity';
import {
  DEFAULT_PRO_STANDARD_ERROR_TYPE,
  PRO_STANDARD_ERROR_LABELS,
  type PyodideOlsResult,
} from './pyodide/proResultTypes';
import type {
  ProAcfPoint,
  ProArimaResult,
  ProLjungBoxRow,
  PyodideTimeSeriesResult,
} from './pyodide/proTimeSeriesResultTypes';

// ── Helpers de formato ────────────────────────────────────────────────────────

// Markdown / TXT: 6 decimales, "N/D" para null/undefined/no-finito.
function reportNum(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/D';
  return value.toFixed(6);
}

// Markdown / TXT: entero o etiqueta, "N/D" para null/undefined/no-finito.
function reportInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/D';
  return String(value);
}

// CSV: campo vacío para null/undefined/no-finito; nunca NaN ni Infinity.
function csvNum(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  return String(value);
}

function csvLine(cells: Array<string | number>): string {
  return cells.map(csvCell).join(',');
}

function formLabel(result: PyodideOlsResult): string {
  return result.functionalForm ? FORM_LABELS[result.functionalForm] : 'N/D';
}

function inferenceLabel(result: PyodideOlsResult): string {
  return PRO_STANDARD_ERROR_LABELS[result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE];
}

const PRO_ENGINE_LABEL = 'Pyodide + Python + statsmodels';

// Notas pedagógicas fijas (no dependen de los datos).
const REGRESSION_NOTES: readonly string[] = [
  'Los coeficientes estiman asociaciones, no causalidad automática.',
  'Los errores robustos no cambian los betas, cambian la inferencia.',
  'Los modelos con logs requieren valores positivos.',
];

const TIME_SERIES_NOTES: readonly string[] = [
  'ARIMA no adivina el futuro.',
  'El forecast depende del modelo estimado.',
  'Los intervalos expresan incertidumbre.',
  'Auto-ARIMA no está implementado todavía.',
];

// ── Regresión Pro — Markdown ──────────────────────────────────────────────────

export function buildProRegressionMarkdown(result: PyodideOlsResult): string {
  const lines: string[] = [];

  lines.push('# ChartBay Pro — Reporte de regresión');
  lines.push('');
  lines.push('## Modelo');
  lines.push('');
  lines.push('- Motor: Pro');
  lines.push(`- Motor de cálculo: ${PRO_ENGINE_LABEL}`);
  lines.push(`- Forma funcional: ${formLabel(result)}`);
  lines.push(`- Variable dependiente: ${result.yName ?? 'N/D'}`);
  lines.push(`- Variables explicativas: ${result.xNames && result.xNames.length > 0 ? result.xNames.join(', ') : 'N/D'}`);
  lines.push(`- Observaciones: ${reportInt(result.nobs)}`);
  lines.push(`- Inferencia: ${inferenceLabel(result)}`);
  lines.push('');

  lines.push('## Coeficientes');
  lines.push('');
  lines.push('| Variable | Coeficiente | Error estándar | t-stat | p-value |');
  lines.push('|---|---:|---:|---:|---:|');
  for (const c of result.coefficients ?? []) {
    lines.push(`| ${c.name} | ${reportNum(c.estimate)} | ${reportNum(c.stdError)} | ${reportNum(c.tStat)} | ${reportNum(c.pValue)} |`);
  }
  lines.push('');

  lines.push('## Bondad de ajuste');
  lines.push('');
  lines.push(`- R²: ${reportNum(result.rSquared)}`);
  lines.push(`- R² ajustado: ${reportNum(result.rSquaredAdj)}`);
  lines.push(`- F-stat: ${reportNum(result.fStat)}`);
  lines.push(`- p-value (F): ${reportNum(result.fPValue)}`);
  lines.push(`- Grados de libertad (residual): ${reportInt(result.dfResid)}`);
  lines.push('');

  if (result.categoricalInfo && result.categoricalInfo.length > 0) {
    lines.push('## Variables categóricas');
    lines.push('');
    for (const c of result.categoricalInfo) {
      lines.push(`- Variable categórica: ${c.originalName}`);
      lines.push(`- Categoría base: ${c.baseCategory}`);
      lines.push(`- Dummies creadas: ${c.createdDummies.join(', ')}`);
    }
    lines.push('- Nota: la categoría base se omite para evitar la trampa de dummies.');
    lines.push('');
  }

  if (result.rlsTest) {
    const rls = result.rlsTest;
    const seType = result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE;
    lines.push('## Test de restricción (RLS / Wald-F)');
    lines.push('');
    lines.push(`- H0: ${rls.label}`);
    lines.push(`- F-stat: ${reportNum(rls.fStat)}`);
    lines.push(`- p-value: ${reportNum(rls.fPValue)}`);
    lines.push(`- Grados de libertad: ${reportInt(rls.dfNum)}, ${reportInt(rls.dfDenom)}`);
    lines.push(`- Conclusión: ${rls.reject ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%'}`);
    lines.push(
      seType === 'classic'
        ? '- Nota: el test usa errores estándar clásicos y debería coincidir con el F clásico de Lite salvo diferencias numéricas mínimas.'
        : `- Nota: el test usa la matriz de covarianza robusta (${PRO_STANDARD_ERROR_LABELS[seType]}); por eso puede diferir del F clásico de Lite.`
    );
    lines.push('- El test no re-estima los coeficientes bajo la restricción: sólo evalúa si Rβ = q es compatible con los datos.');
    lines.push('');
  }

  if (result.breuschPagan) {
    const bp = result.breuschPagan;
    const seType = result.standardErrorType ?? DEFAULT_PRO_STANDARD_ERROR_TYPE;
    lines.push('## Breusch-Pagan');
    lines.push('');
    lines.push('- H0: homocedasticidad (varianza constante de los errores)');
    lines.push(`- LM statistic: ${reportNum(bp.lmStatistic)}`);
    lines.push(`- LM p-value: ${reportNum(bp.lmPValue)}`);
    lines.push(`- F statistic: ${reportNum(bp.fStatistic)}`);
    lines.push(`- F p-value: ${reportNum(bp.fPValue)}`);
    lines.push(`- Conclusión: ${bp.interpretation}`);
    if (seType === 'classic' && bp.rejectAt5) {
      lines.push('- Sugerencia: el test sugiere heterocedasticidad; probá HC3 para inferencia más robusta.');
    }
    lines.push(`- ${BREUSCH_PAGAN_NOTE}`);
    lines.push('');
  }

  lines.push('## Notas de interpretación');
  lines.push('');
  for (const note of REGRESSION_NOTES) lines.push(`- ${note}`);
  lines.push('');

  return lines.join('\n');
}

// ── Regresión Pro — TXT ───────────────────────────────────────────────────────

export function buildProRegressionText(result: PyodideOlsResult): string {
  const lines: string[] = [];

  lines.push('ChartBay Pro - Reporte de regresion');
  lines.push('');
  lines.push('Modelo');
  lines.push('- Motor: Pro');
  lines.push(`- Motor de calculo: ${PRO_ENGINE_LABEL}`);
  lines.push(`- Forma funcional: ${formLabel(result)}`);
  lines.push(`- Variable dependiente: ${result.yName ?? 'N/D'}`);
  lines.push(`- Variables explicativas: ${result.xNames && result.xNames.length > 0 ? result.xNames.join(', ') : 'N/D'}`);
  lines.push(`- Observaciones: ${reportInt(result.nobs)}`);
  lines.push(`- Inferencia: ${inferenceLabel(result)}`);
  lines.push('');

  lines.push('Coeficientes');
  lines.push('Variable\tCoeficiente\tError estandar\tt-stat\tp-value');
  for (const c of result.coefficients ?? []) {
    lines.push(`${c.name}\t${reportNum(c.estimate)}\t${reportNum(c.stdError)}\t${reportNum(c.tStat)}\t${reportNum(c.pValue)}`);
  }
  lines.push('');

  lines.push('Bondad de ajuste');
  lines.push(`R2: ${reportNum(result.rSquared)}`);
  lines.push(`R2 ajustado: ${reportNum(result.rSquaredAdj)}`);
  lines.push(`F-stat: ${reportNum(result.fStat)}`);
  lines.push(`p-value (F): ${reportNum(result.fPValue)}`);
  lines.push(`Grados de libertad (residual): ${reportInt(result.dfResid)}`);
  lines.push('');

  if (result.categoricalInfo && result.categoricalInfo.length > 0) {
    lines.push('Variables categoricas');
    for (const c of result.categoricalInfo) {
      lines.push(`${c.originalName}: categoria base = ${c.baseCategory} | dummies = ${c.createdDummies.join(', ')}`);
    }
    lines.push('La categoria base se omite para evitar la trampa de dummies.');
    lines.push('');
  }

  if (result.rlsTest) {
    const rls = result.rlsTest;
    lines.push('Test de restriccion (Wald/F)');
    lines.push(`H0: ${rls.label}`);
    lines.push(`F-stat: ${reportNum(rls.fStat)}`);
    lines.push(`p-value: ${reportNum(rls.fPValue)}`);
    lines.push(`Conclusion: ${rls.reject ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%'}`);
    lines.push('');
  }

  if (result.breuschPagan) {
    const bp = result.breuschPagan;
    lines.push('Breusch-Pagan');
    lines.push('H0: homocedasticidad');
    lines.push(`LM statistic: ${reportNum(bp.lmStatistic)} | p-value: ${reportNum(bp.lmPValue)}`);
    lines.push(`F statistic: ${reportNum(bp.fStatistic)} | p-value: ${reportNum(bp.fPValue)}`);
    lines.push(`Conclusion: ${bp.interpretation}`);
    lines.push('');
  }

  lines.push('Notas de interpretacion');
  for (const note of REGRESSION_NOTES) lines.push(`- ${note}`);
  lines.push('');

  return lines.join('\n');
}

// ── Regresión Pro — CSV (coeficientes = CSV principal) ────────────────────────

export function buildProRegressionCoefficientsCsv(result: PyodideOlsResult): string {
  const rows: string[] = [csvLine(['variable', 'coefficient', 'standard_error', 'statistic', 'p_value'])];
  for (const c of result.coefficients ?? []) {
    rows.push(csvLine([c.name, csvNum(c.estimate), csvNum(c.stdError), csvNum(c.tStat), csvNum(c.pValue)]));
  }
  return rows.join('\n');
}

// CSV opcional de ajustados/residuos (una fila por observación). Sólo se emite
// contenido cuando ambos arreglos existen y coinciden en longitud.
export function buildProRegressionFittedCsv(result: PyodideOlsResult): string {
  const rows: string[] = [csvLine(['index', 'fitted', 'residual'])];
  const fitted = result.fitted;
  const residuals = result.residuals;
  if (fitted && residuals && fitted.length === residuals.length) {
    for (let i = 0; i < fitted.length; i += 1) {
      rows.push(csvLine([i, csvNum(fitted[i]), csvNum(residuals[i])]));
    }
  }
  return rows.join('\n');
}

// ── Series de tiempo Pro — helpers ────────────────────────────────────────────

function mergeAcfPacf(
  acf: ProAcfPoint[] | undefined,
  pacf: ProAcfPoint[] | undefined
): Array<{ lag: number; acf: number | null; pacf: number | null }> {
  const acfByLag = new Map<number, number>();
  for (const point of acf ?? []) acfByLag.set(point.lag, point.value);
  const pacfByLag = new Map<number, number>();
  for (const point of pacf ?? []) pacfByLag.set(point.lag, point.value);
  const lags = Array.from(new Set([...acfByLag.keys(), ...pacfByLag.keys()])).sort((a, b) => a - b);
  return lags.map(lag => ({
    lag,
    acf: acfByLag.has(lag) ? acfByLag.get(lag)! : null,
    pacf: pacfByLag.has(lag) ? pacfByLag.get(lag)! : null,
  }));
}

function ljungBoxVerdict(row: ProLjungBoxRow): string {
  return row.rejectAt5 ? 'Se rechaza H0 al 5%' : 'No se rechaza H0 al 5%';
}

// ── Series de tiempo Pro — Markdown ───────────────────────────────────────────

export function buildProTimeSeriesMarkdown(result: PyodideTimeSeriesResult): string {
  const lines: string[] = [];

  lines.push('# ChartBay Pro — Reporte de series de tiempo');
  lines.push('');
  lines.push('## Serie');
  lines.push('');
  lines.push(`- Variable analizada: ${result.variableName ?? 'N/D'}`);
  lines.push(`- Observaciones: ${reportInt(result.observations)}`);
  lines.push(`- Motor: ${PRO_ENGINE_LABEL}`);
  lines.push('');

  lines.push('## ADF');
  lines.push('');
  if (result.adf) {
    const adf = result.adf;
    const crit = Object.entries(adf.criticalValues);
    lines.push('- H0: la serie tiene raíz unitaria (no es estacionaria)');
    lines.push(`- Estadístico: ${reportNum(adf.statistic)}`);
    lines.push(`- p-value: ${reportNum(adf.pValue)}`);
    lines.push(`- Rezagos usados: ${reportInt(adf.usedLag)}`);
    lines.push(`- Valores críticos: ${crit.length > 0 ? crit.map(([k, v]) => `${k}: ${reportNum(v)}`).join(', ') : 'N/D'}`);
    lines.push(`- Conclusión: ${adf.interpretation}`);
  } else {
    lines.push('- ADF no disponible para esta serie.');
  }
  lines.push('');

  const acfPacf = mergeAcfPacf(result.acf, result.pacf);
  lines.push('## ACF / PACF');
  lines.push('');
  if (acfPacf.length > 0) {
    lines.push('| Lag | ACF | PACF |');
    lines.push('|---:|---:|---:|');
    for (const row of acfPacf) {
      lines.push(`| ${row.lag} | ${reportNum(row.acf)} | ${reportNum(row.pacf)} |`);
    }
  } else {
    lines.push('ACF/PACF no disponibles para esta serie.');
  }
  lines.push('');

  lines.push('## Ljung-Box');
  lines.push('');
  if (result.ljungBox && result.ljungBox.length > 0) {
    lines.push('| Lag | Q-stat | p-value | Conclusión |');
    lines.push('|---:|---:|---:|---|');
    for (const row of result.ljungBox) {
      lines.push(`| ${row.lag} | ${reportNum(row.statistic)} | ${reportNum(row.pValue)} | ${ljungBoxVerdict(row)} |`);
    }
  } else {
    lines.push('Ljung-Box no disponible para los rezagos seleccionados.');
  }
  lines.push('');

  appendArimaMarkdown(lines, result);

  lines.push('## Notas');
  lines.push('');
  for (const note of TIME_SERIES_NOTES) lines.push(`- ${note}`);
  lines.push('');

  return lines.join('\n');
}

function appendArimaMarkdown(lines: string[], result: PyodideTimeSeriesResult): void {
  const arima: ProArimaResult | undefined = result.arima;

  lines.push('## ARIMA');
  lines.push('');
  if (result.arimaError) {
    lines.push(`- ARIMA no disponible: ${result.arimaError}`);
    lines.push('');
    return;
  }
  if (!arima) {
    lines.push('- ARIMA no se estimó en esta corrida.');
    lines.push('');
    return;
  }

  const converged = arima.converged === true ? 'Sí' : arima.converged === false ? 'No' : 'No informada';
  lines.push(`- Modelo estimado: ARIMA(${arima.order.p},${arima.order.d},${arima.order.q})`);
  lines.push(`- Convergencia: ${converged}`);
  lines.push(`- Log-likelihood: ${reportNum(arima.logLikelihood)}`);
  lines.push(`- AIC: ${reportNum(arima.aic)}`);
  lines.push(`- BIC: ${reportNum(arima.bic)}`);
  lines.push(`- HQIC: ${reportNum(arima.hqic)}`);
  lines.push(`- Observaciones usadas: ${reportInt(arima.nobs)}`);
  lines.push('');

  if (arima.coefficients.length > 0) {
    lines.push('### Coeficientes ARIMA');
    lines.push('');
    lines.push('| Parámetro | Estimación | Error estándar | z-stat | p-value |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const c of arima.coefficients) {
      lines.push(`| ${c.name} | ${reportNum(c.estimate)} | ${reportNum(c.standardError)} | ${reportNum(c.zStatistic)} | ${reportNum(c.pValue)} |`);
    }
    lines.push('');
  }

  const resid = result.arimaResidualDiagnostics;
  if (resid && resid.ljungBox.length > 0) {
    lines.push('### Diagnóstico de residuos');
    lines.push('');
    lines.push('| Lag | Q-stat | p-value | Conclusión |');
    lines.push('|---:|---:|---:|---|');
    for (const row of resid.ljungBox) {
      lines.push(`| ${row.lag} | ${reportNum(row.statistic)} | ${reportNum(row.pValue)} | ${ljungBoxVerdict(row)} |`);
    }
    lines.push('');
  }

  if (arima.forecastError) {
    lines.push('## Forecast');
    lines.push('');
    lines.push(`- Forecast no disponible: ${arima.forecastError}`);
    lines.push('');
  } else if (arima.forecast && arima.forecast.items.length > 0) {
    const forecast = arima.forecast;
    lines.push('## Forecast');
    lines.push('');
    lines.push('| Paso | Pronóstico | Error estándar | Límite inferior | Límite superior |');
    lines.push('|---:|---:|---:|---:|---:|');
    for (const item of forecast.items) {
      lines.push(`| t+${item.step} | ${reportNum(item.mean)} | ${reportNum(item.meanStandardError)} | ${reportNum(item.lower)} | ${reportNum(item.upper)} |`);
    }
    lines.push('');
  }
}

// ── Series de tiempo Pro — TXT ────────────────────────────────────────────────

export function buildProTimeSeriesText(result: PyodideTimeSeriesResult): string {
  const lines: string[] = [];

  lines.push('ChartBay Pro - Reporte de series de tiempo');
  lines.push('');
  lines.push('Serie');
  lines.push(`- Variable analizada: ${result.variableName ?? 'N/D'}`);
  lines.push(`- Observaciones: ${reportInt(result.observations)}`);
  lines.push(`- Motor: ${PRO_ENGINE_LABEL}`);
  lines.push('');

  lines.push('ADF');
  if (result.adf) {
    const adf = result.adf;
    lines.push('H0: la serie tiene raiz unitaria (no es estacionaria)');
    lines.push(`Estadistico: ${reportNum(adf.statistic)}`);
    lines.push(`p-value: ${reportNum(adf.pValue)}`);
    lines.push(`Rezagos usados: ${reportInt(adf.usedLag)}`);
    lines.push(`Conclusion: ${adf.interpretation}`);
  } else {
    lines.push('ADF no disponible para esta serie.');
  }
  lines.push('');

  const acfPacf = mergeAcfPacf(result.acf, result.pacf);
  lines.push('ACF / PACF');
  if (acfPacf.length > 0) {
    lines.push('Lag\tACF\tPACF');
    for (const row of acfPacf) {
      lines.push(`${row.lag}\t${reportNum(row.acf)}\t${reportNum(row.pacf)}`);
    }
  } else {
    lines.push('ACF/PACF no disponibles para esta serie.');
  }
  lines.push('');

  lines.push('Ljung-Box');
  if (result.ljungBox && result.ljungBox.length > 0) {
    lines.push('Lag\tQ-stat\tp-value\tConclusion');
    for (const row of result.ljungBox) {
      lines.push(`${row.lag}\t${reportNum(row.statistic)}\t${reportNum(row.pValue)}\t${ljungBoxVerdict(row)}`);
    }
  } else {
    lines.push('Ljung-Box no disponible para los rezagos seleccionados.');
  }
  lines.push('');

  const arima = result.arima;
  lines.push('ARIMA');
  if (result.arimaError) {
    lines.push(`ARIMA no disponible: ${result.arimaError}`);
  } else if (!arima) {
    lines.push('ARIMA no se estimo en esta corrida.');
  } else {
    lines.push(`Modelo estimado: ARIMA(${arima.order.p},${arima.order.d},${arima.order.q})`);
    lines.push(`Log-likelihood: ${reportNum(arima.logLikelihood)}`);
    lines.push(`AIC: ${reportNum(arima.aic)} | BIC: ${reportNum(arima.bic)} | HQIC: ${reportNum(arima.hqic)}`);
    if (arima.coefficients.length > 0) {
      lines.push('Coeficientes ARIMA');
      lines.push('Parametro\tEstimacion\tError estandar\tz-stat\tp-value');
      for (const c of arima.coefficients) {
        lines.push(`${c.name}\t${reportNum(c.estimate)}\t${reportNum(c.standardError)}\t${reportNum(c.zStatistic)}\t${reportNum(c.pValue)}`);
      }
    }
    if (arima.forecastError) {
      lines.push('');
      lines.push('Forecast');
      lines.push(`Forecast no disponible: ${arima.forecastError}`);
    } else if (arima.forecast && arima.forecast.items.length > 0) {
      lines.push('');
      lines.push('Forecast');
      lines.push('Paso\tPronostico\tError estandar\tLimite inferior\tLimite superior');
      for (const item of arima.forecast.items) {
        lines.push(`t+${item.step}\t${reportNum(item.mean)}\t${reportNum(item.meanStandardError)}\t${reportNum(item.lower)}\t${reportNum(item.upper)}`);
      }
    }
  }
  lines.push('');

  lines.push('Notas');
  for (const note of TIME_SERIES_NOTES) lines.push(`- ${note}`);
  lines.push('');

  return lines.join('\n');
}

// ── Series de tiempo Pro — CSV ────────────────────────────────────────────────

export function buildProTimeSeriesForecastCsv(result: PyodideTimeSeriesResult): string {
  const rows: string[] = [csvLine(['step', 'mean', 'mean_standard_error', 'lower', 'upper'])];
  const forecast = result.arima?.forecast;
  if (forecast) {
    for (const item of forecast.items) {
      rows.push(csvLine([item.step, csvNum(item.mean), csvNum(item.meanStandardError), csvNum(item.lower), csvNum(item.upper)]));
    }
  }
  return rows.join('\n');
}

export function buildProTimeSeriesAcfPacfCsv(result: PyodideTimeSeriesResult): string {
  const rows: string[] = [csvLine(['lag', 'acf', 'pacf'])];
  for (const row of mergeAcfPacf(result.acf, result.pacf)) {
    rows.push(csvLine([row.lag, csvNum(row.acf), csvNum(row.pacf)]));
  }
  return rows.join('\n');
}

// Indica si hay forecast exportable, para que el CSV "principal" de series
// elija forecast cuando existe y ACF/PACF en caso contrario (sin inventar).
export function hasProForecast(result: PyodideTimeSeriesResult): boolean {
  return !!result.arima?.forecast && result.arima.forecast.items.length > 0;
}
