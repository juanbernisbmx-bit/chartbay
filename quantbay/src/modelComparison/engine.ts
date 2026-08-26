import type {
  CoefficientChange,
  CoefficientComparisonRow,
  ComparabilityReport,
  ComparisonWarning,
  DiagnosticComparisonRow,
  ModelComparisonResult,
  ModelMetricRow,
  ModelSnapshot,
  PedagogicalDifference,
} from './types';

const METRICS: Array<{ key: ModelMetricRow['key']; label: string }> = [
  { key: 'nObs', label: 'Observaciones' },
  { key: 'regressorCount', label: 'Regresores' },
  { key: 'rSquared', label: 'R²' },
  { key: 'adjustedRSquared', label: 'R² ajustado' },
  { key: 'fStatistic', label: 'Estadístico F' },
  { key: 'fPValue', label: 'p-valor F' },
  { key: 'aic', label: 'AIC' },
  { key: 'bic', label: 'BIC' },
  { key: 'standardErrorType', label: 'Errores estándar' },
  { key: 'functionalForm', label: 'Forma funcional' },
  { key: 'estimationMethod', label: 'Estimación' },
];

function allSame<T>(values: T[]): boolean {
  return values.every(value => value === values[0]);
}

function warning(code: ComparisonWarning['code'], message: string, level: ComparisonWarning['level'] = 'warning'): ComparisonWarning {
  return { code, message, level };
}

function covarianceKey(model: ModelSnapshot): string {
  const { standardErrorType, hacMaxLags } = model.specification;
  return standardErrorType === 'HAC' ? `HAC:${hacMaxLags ?? '?'}` : standardErrorType ?? 'desconocido';
}

function dummyBaseKey(model: ModelSnapshot): string {
  return JSON.stringify(Object.entries(model.specification.categoricalBaseCategories).sort(([a], [b]) => a.localeCompare(b)));
}

export function assessComparability(models: ModelSnapshot[]): ComparabilityReport {
  const warnings: ComparisonWarning[] = [];
  if (models.length < 2) {
    return { level: 'direct', warnings, compareFitMetrics: false, compareInformationCriteria: false, compareCoefficients: false, compareInference: false };
  }
  if (!allSame(models.map(model => model.specification.flow))) {
    warnings.push(warning('different_flow', 'Hay modelos de corte transversal y de series de tiempo. Sus resultados no deben compararse en una misma escala.', 'block'));
  }
  if (!allSame(models.map(model => model.specification.family))) {
    warnings.push(warning('different_family', 'Las familias de modelos son distintas. La comparación directa entre regresiones lineales y ARIMA queda bloqueada.', 'block'));
  }
  if (!allSame(models.map(model => model.specification.dependentVariable))) {
    warnings.push(warning('different_dependent_variable', 'La variable dependiente no es la misma en todos los modelos.', 'block'));
  }
  if (!allSame(models.map(model => model.specification.outcomeScale))) {
    warnings.push(warning('different_outcome_scale', 'La variable dependiente está en nivel en algunos modelos y en logaritmo en otros; los coeficientes y el ajuste no están en la misma escala.'));
  }
  if (!allSame(models.map(model => model.datasetId))) {
    warnings.push(warning('different_dataset', 'Los modelos provienen de cargas de datos distintas; aunque el archivo tenga el mismo nombre, la muestra puede haber cambiado.'));
  }
  if (!allSame(models.map(model => model.metrics.nObs))) {
    warnings.push(warning('different_sample_size', 'La cantidad de observaciones difiere entre modelos. Puede deberse a valores faltantes o transformaciones.'));
  }
  if (!allSame(models.map(model => model.specification.functionalForm))) {
    warnings.push(warning('different_functional_form', 'Las formas funcionales difieren; cada beta puede representar unidades, porcentajes o elasticidades distintas.'));
  }
  if (!allSame(models.map(covarianceKey))) {
    warnings.push(warning('different_covariance', 'Los betas pueden compararse, pero la inferencia usa matrices de covarianza distintas; compare errores estándar y p-valores con cautela.'));
  }
  if (!allSame(models.map(dummyBaseKey))) {
    warnings.push(warning('different_dummy_base', 'Las categorías base de al menos una variable dummy difieren; esos coeficientes no tienen la misma referencia.'));
  }

  const blocked = warnings.some(item => item.level === 'block');
  const sameOutcomeScale = !warnings.some(item => item.code === 'different_outcome_scale');
  const sameFunctionalForm = !warnings.some(item => item.code === 'different_functional_form');
  const sameSample = !warnings.some(item => item.code === 'different_dataset' || item.code === 'different_sample_size');
  const sameFamily = !warnings.some(item => item.code === 'different_family' || item.code === 'different_flow');
  return {
    level: blocked ? 'incompatible' : warnings.length ? 'caution' : 'direct',
    warnings,
    compareFitMetrics: !blocked && sameOutcomeScale && sameSample,
    compareInformationCriteria: !blocked && sameOutcomeScale && sameSample && sameFamily,
    compareCoefficients: !blocked && sameOutcomeScale && sameFunctionalForm,
    compareInference: !blocked && sameOutcomeScale && sameFunctionalForm && !warnings.some(item => item.code === 'different_covariance' || item.code === 'different_dummy_base'),
  };
}

function significant(pValue: number | null): boolean | null {
  return pValue === null ? null : pValue < 0.05;
}

function coefficientRows(models: ModelSnapshot[], comparable: boolean): CoefficientComparisonRow[] {
  const keys: string[] = [];
  const labels = new Map<string, string>();
  for (const model of models) {
    for (const coefficient of model.coefficients) {
      if (!keys.includes(coefficient.key)) keys.push(coefficient.key);
      labels.set(coefficient.key, coefficient.name);
    }
  }
  return keys.map(key => {
    const cells = models.map(model => ({ modelId: model.id, coefficient: model.coefficients.find(item => item.key === key) ?? null }));
    const estimates = cells.map(cell => cell.coefficient?.estimate ?? null).filter((value): value is number => value !== null);
    const inference = cells.map(cell => significant(cell.coefficient?.pValue ?? null)).filter((value): value is boolean => value !== null);
    return {
      key,
      label: labels.get(key) ?? key,
      presentInAll: cells.every(cell => cell.coefficient !== null),
      changed: comparable && estimates.length > 1 && !allSame(estimates),
      significanceChanged: comparable && inference.length > 1 && !allSame(inference),
      cells,
    };
  });
}

function metricRows(models: ModelSnapshot[], comparability: ComparabilityReport): ModelMetricRow[] {
  return METRICS.map(({ key, label }) => {
    let values: Array<number | string | null>;
    if (key === 'standardErrorType' || key === 'functionalForm' || key === 'estimationMethod') {
      values = models.map(model => model.specification[key] ?? null);
    } else {
      values = models.map(model => model.metrics[key]);
    }
    const isFit = ['rSquared', 'adjustedRSquared', 'fStatistic', 'fPValue'].includes(key);
    const isInformation = key === 'aic' || key === 'bic';
    return { key, label, values, comparable: isInformation ? comparability.compareInformationCriteria : isFit ? comparability.compareFitMetrics : true };
  });
}

function diagnosticRows(models: ModelSnapshot[]): DiagnosticComparisonRow[] {
  const categories = Array.from(new Set(models.flatMap(model => model.doctor.findings.map(finding => finding.category))));
  return categories.map(category => ({
    category,
    values: models.map(model => model.doctor.findings.find(finding => finding.category === category)?.state ?? null),
  }));
}

function buildChanges(models: ModelSnapshot[], rows: CoefficientComparisonRow[], comparability: ComparabilityReport): CoefficientChange[] {
  if (!comparability.compareCoefficients || models.length < 2) return [];
  const baseline = models[0];
  const changes: CoefficientChange[] = [];
  for (const model of models.slice(1)) {
    for (const row of rows) {
      const first = row.cells.find(cell => cell.modelId === baseline.id)?.coefficient;
      const next = row.cells.find(cell => cell.modelId === model.id)?.coefficient;
      if (first?.estimate === null || first?.estimate === undefined || next?.estimate === null || next?.estimate === undefined) continue;
      const delta = next.estimate - first.estimate;
      if (delta === 0 && significant(first.pValue) === significant(next.pValue)) continue;
      changes.push({
        coefficientKey: row.key,
        coefficientLabel: row.label,
        baselineModelId: baseline.id,
        comparisonModelId: model.id,
        baselineEstimate: first.estimate,
        comparisonEstimate: next.estimate,
        delta,
        significanceChanged: significant(first.pValue) !== null && significant(next.pValue) !== null && significant(first.pValue) !== significant(next.pValue),
        text: `${row.label}: el estimador cambia de ${first.estimate.toPrecision(4)} a ${next.estimate.toPrecision(4)}. Esta diferencia describe especificaciones distintas; por sí sola no identifica su causa.`,
      });
    }
  }
  return changes;
}

function buildDifferences(models: ModelSnapshot[], comparability: ComparabilityReport, changes: CoefficientChange[]): PedagogicalDifference[] {
  if (models.length < 2) return [];
  const baseline = models[0];
  const differences: PedagogicalDifference[] = [];
  for (const model of models.slice(1)) {
    const baselineX = new Set(baseline.specification.regressors);
    const nextX = new Set(model.specification.regressors);
    const added = [...nextX].filter(item => !baselineX.has(item));
    const removed = [...baselineX].filter(item => !nextX.has(item));
    if (added.length) differences.push({ kind: 'specification', text: `${model.name ?? 'El modelo'} agrega: ${added.join(', ')}.` });
    if (removed.length) differences.push({ kind: 'specification', text: `${model.name ?? 'El modelo'} excluye: ${removed.join(', ')}.` });
    if (comparability.compareFitMetrics && baseline.metrics.adjustedRSquared !== null && model.metrics.adjustedRSquared !== null) {
      const delta = model.metrics.adjustedRSquared - baseline.metrics.adjustedRSquared;
      differences.push({ kind: 'fit', text: `El R² ajustado cambia ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} respecto del modelo base. Es un cambio descriptivo del ajuste, no una selección automática.` });
    }
  }
  if (comparability.warnings.some(item => item.code === 'different_covariance')) {
    differences.push({ kind: 'inference', text: 'Cambiar el tipo de error estándar no modifica los betas OLS, pero sí puede modificar errores estándar, intervalos y significancia.' });
  }
  for (const change of changes.filter(item => item.significanceChanged)) {
    differences.push({ kind: 'significance', text: `${change.coefficientLabel} cruza el umbral descriptivo de 5%; revise el p-valor y el tipo de error estándar antes de interpretarlo.` });
  }
  return differences;
}

export function compareModels(models: ModelSnapshot[]): ModelComparisonResult {
  const comparability = assessComparability(models);
  const rows = coefficientRows(models, comparability.compareCoefficients);
  const changes = buildChanges(models, rows, comparability);
  return {
    models,
    comparability,
    coefficientRows: rows,
    metricRows: metricRows(models, comparability),
    diagnosticRows: diagnosticRows(models),
    coefficientChanges: changes,
    differences: buildDifferences(models, comparability, changes),
  };
}
