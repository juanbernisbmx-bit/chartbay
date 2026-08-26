import { describe, expect, it } from 'vitest';
import { compareModels } from '../src/modelComparison/engine';
import type { ModelSnapshot } from '../src/modelComparison/types';
import { renderModelComparisonHtml } from '../src/ui/modelComparisonView';

function snapshot(id: string, name: string, includeX = true): ModelSnapshot {
  return {
    id, name, createdAt: '', datasetId: 'd', specification: {
      flow: 'cross-section', family: 'linear', engine: 'lite', dependentVariable: 'y', outcomeScale: 'level',
      regressors: includeX ? ['x'] : [], functionalForm: 'lin-lin', estimationMethod: 'OLS', standardErrorType: 'classic',
      hasIntercept: true, categoricalBaseCategories: {},
    },
    coefficients: includeX ? [{ key: 'x', name: '<script>x</script>', estimate: 1, stdError: null, statistic: null, pValue: null, confidenceInterval: null, isIntercept: false }] : [],
    metrics: { nObs: 20, regressorCount: includeX ? 1 : 0, rSquared: 0.5, adjustedRSquared: 0.4, fStatistic: null, fPValue: null, aic: null, bic: null },
    interpretation: [], doctor: { overallState: 'clear', headline: null, findings: [], coverage: { evaluated: 0, applicable: 0, skipped: [] }, limits: [], flow: 'cross-section' }, warnings: [],
  };
}

describe('vista de comparación', () => {
  it('escapa nombres y muestra explícitamente variables no incluidas', () => {
    const html = renderModelComparisonHtml(compareModels([snapshot('1', '<img src=x>'), snapshot('2', 'Modelo 2', false)]));
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('— No incluida');
  });

  it('incluye la cautela pedagógica y no asigna un ganador', () => {
    const html = renderModelComparisonHtml(compareModels([snapshot('1', 'Base'), snapshot('2', 'Ampliado', false)]));
    expect(html).toContain('No prueban causalidad');
    expect(html.toLowerCase()).not.toContain('mejor modelo');
  });
});
