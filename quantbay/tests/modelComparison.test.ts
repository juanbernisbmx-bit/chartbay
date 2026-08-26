import { describe, expect, it } from 'vitest';
import { compareModels } from '../src/modelComparison/engine';
import type { DoctorReport } from '../src/modelDoctor/types';
import type { ModelSnapshot } from '../src/modelComparison/types';

const doctor: DoctorReport = {
  overallState: 'clear', headline: null, findings: [],
  coverage: { evaluated: 0, applicable: 0, skipped: [] }, limits: [], flow: 'cross-section',
};

function model(id: string, overrides: Partial<ModelSnapshot> = {}): ModelSnapshot {
  return {
    id, name: id, createdAt: '2026-08-26T00:00:00.000Z', datasetId: 'data-1', datasetLabel: 'datos.csv',
    specification: {
      flow: 'cross-section', family: 'linear', engine: 'lite', dependentVariable: 'y', outcomeScale: 'level',
      regressors: ['x'], functionalForm: 'lin-lin', estimationMethod: 'OLS', standardErrorType: 'classic',
      hacMaxLags: null, hasIntercept: true, restriction: null, categoricalBaseCategories: {},
    },
    coefficients: [
      { key: '__intercept__', name: 'Intercepto', estimate: 1, stdError: 0.2, statistic: 5, pValue: 0.001, confidenceInterval: [0.6, 1.4], isIntercept: true },
      { key: 'x', name: 'x', estimate: 2, stdError: 0.5, statistic: 4, pValue: 0.01, confidenceInterval: [1, 3], isIntercept: false },
    ],
    metrics: { nObs: 100, regressorCount: 1, rSquared: 0.6, adjustedRSquared: 0.59, fStatistic: 16, fPValue: 0.001, aic: null, bic: null },
    interpretation: [], doctor, warnings: [], ...overrides,
  };
}

describe('comparación de modelos', () => {
  it('permite comparación directa con misma Y, escala, muestra y covarianza', () => {
    const result = compareModels([model('m1'), model('m2')]);
    expect(result.comparability.level).toBe('direct');
    expect(result.comparability.compareFitMetrics).toBe(true);
  });

  it('representa una variable ausente como ausencia, nunca como coeficiente cero', () => {
    const second = model('m2', { coefficients: model('tmp').coefficients.slice(0, 1), specification: { ...model('tmp').specification, regressors: [] } });
    const row = compareModels([model('m1'), second]).coefficientRows.find(item => item.key === 'x');
    expect(row?.presentInAll).toBe(false);
    expect(row?.cells[1].coefficient).toBeNull();
  });

  it('bloquea familias y variables dependientes distintas', () => {
    const arima = model('arima', { specification: { ...model('tmp').specification, flow: 'time-series', family: 'arima', dependentVariable: 'inflacion' } });
    const comparison = compareModels([model('ols'), arima]).comparability;
    expect(comparison.level).toBe('incompatible');
    expect(comparison.compareCoefficients).toBe(false);
    expect(comparison.warnings.map(item => item.code)).toEqual(expect.arrayContaining(['different_flow', 'different_family', 'different_dependent_variable']));
  });

  it('oculta comparaciones de ajuste cuando cambia la escala de Y o la muestra', () => {
    const logged = model('log', {
      datasetId: 'data-2',
      specification: { ...model('tmp').specification, outcomeScale: 'log', functionalForm: 'log-lin' },
      metrics: { ...model('tmp').metrics, nObs: 92 },
    });
    const comparison = compareModels([model('level'), logged]).comparability;
    expect(comparison.level).toBe('caution');
    expect(comparison.compareFitMetrics).toBe(false);
    expect(comparison.compareInformationCriteria).toBe(false);
    expect(comparison.compareCoefficients).toBe(false);
  });

  it('separa betas OLS de la inferencia cuando cambian errores estándar robustos', () => {
    const robust = model('robust', {
      specification: { ...model('tmp').specification, engine: 'pro', standardErrorType: 'HC3' },
      coefficients: model('tmp').coefficients.map(item => item.key === 'x' ? { ...item, stdError: 1.4, pValue: 0.16 } : item),
    });
    const result = compareModels([model('classic'), robust]);
    expect(result.comparability.compareCoefficients).toBe(true);
    expect(result.comparability.compareInference).toBe(false);
    expect(result.coefficientRows.find(item => item.key === 'x')?.significanceChanged).toBe(true);
    expect(result.differences.some(item => item.text.includes('no modifica los betas OLS'))).toBe(true);
  });

  it('advierte cambios de categoría base y consume estados existentes del Model Doctor', () => {
    const report: DoctorReport = { ...doctor, findings: [{
      category: 'heteroskedasticity', state: 'mitigated', impact: 'inference', evidence: 'strong', confidence: 'high',
      headlineText: 'Mitigada', sources: [], appliedRules: ['R2'],
      detail: { evidence: [], conclusion: '', whyItMatters: '', whatToCheck: [], whatItDoesNot: [], confidenceNote: '', theory: [] },
    }] };
    const second = model('m2', { doctor: report, specification: { ...model('tmp').specification, categoricalBaseCategories: { region: 'Sur' } } });
    const result = compareModels([model('m1'), second]);
    expect(result.comparability.warnings.some(item => item.code === 'different_dummy_base')).toBe(true);
    expect(result.diagnosticRows.find(item => item.category === 'heteroskedasticity')?.values).toEqual([null, 'mitigated']);
  });

  it('normaliza no finitos como ausentes en los adaptadores y evita lenguaje causal o de ranking', () => {
    const result = compareModels([model('m1'), model('m2', { metrics: { ...model('tmp').metrics, adjustedRSquared: 0.61 } })]);
    const text = [...result.differences.map(item => item.text), ...result.coefficientChanges.map(item => item.text)].join(' ').toLowerCase();
    expect(text).not.toContain('mejor modelo');
    expect(text).not.toContain('sesgo por variable omitida');
    expect(text).not.toContain('causó');
  });
});
