import { describe, it, expect } from 'vitest';
import { interpret } from '../src/interpretation';
import type { RegressionResult } from '../src/regression';

function makeResult(overrides: Partial<RegressionResult> = {}): RegressionResult {
  return {
    coefficients: [2],
    intercept: 1,
    rSquared: 0.85,
    adjustedRSquared: 0.83,
    predictions: [3, 5, 7],
    residuals: [0.1, -0.1, 0],
    equation: 'y = 1 + 2·x',
    featureNames: ['x'],
    yName: 'y',
    nObs: 10,
    nFeatures: 1,
    stdErrors: [0.5, 0.3],
    tStats: [2, 6.67],
    pValues: [0.07, 0.001],
    ci95: [[0.1, 1.9], [1.5, 2.5]],
    df: 8,
    sigma2: 0.5,
    fStat: 44.44,
    fPValue: 0.0003,
    ...overrides,
  };
}

describe('interpret', () => {
  it('includes the R² percentage', () => {
    expect(interpret(makeResult({ rSquared: 0.85 }))).toContain('85.0%');
  });

  it('includes adjusted R² percentage', () => {
    expect(interpret(makeResult({ adjustedRSquared: 0.83 }))).toContain('83.0%');
  });

  it('names the dependent variable', () => {
    expect(interpret(makeResult({ yName: 'ventas' }))).toContain('"ventas"');
  });

  it('names each predictor in coefficient readout', () => {
    const text = interpret(makeResult({ featureNames: ['precio', 'publicidad'] }));
    expect(text).toContain('"precio"');
    expect(text).toContain('"publicidad"');
  });

  it('flags R² < 0.3 with a low-fit warning', () => {
    const text = interpret(makeResult({
      rSquared: 0.2,
      adjustedRSquared: 0.18,
      pValues: [0.2, 0.3],
    }));
    expect(text.toLowerCase()).toMatch(/r²\s*bajo|r²bajo/);
  });

  it('flags R² > 0.95 with a potential overfit warning', () => {
    const text = interpret(makeResult({
      rSquared: 0.97,
      adjustedRSquared: 0.97,
      pValues: [0.001, 0.001],
    }));
    expect(text.toLowerCase()).toMatch(/r²\s*muy alto|sobreajuste|multicolinealidad/);
  });

  it('reports "all significant" when all slope p-values < 0.05', () => {
    const text = interpret(makeResult({ pValues: [0.01, 0.02] }));
    expect(text).toContain('todas');
  });

  it('reports "none significant" when all slope p-values >= 0.05', () => {
    const text = interpret(makeResult({ pValues: [0.5, 0.8] }));
    expect(text).toContain('ninguna');
  });

  it('reports partial significance correctly', () => {
    const text = interpret(makeResult({
      featureNames: ['x1', 'x2'],
      coefficients: [2, 3],
      pValues: [0.5, 0.03, 0.9],
    }));
    expect(text).toMatch(/1 de 2/);
  });

  it('includes the OLS assumptions note', () => {
    expect(interpret(makeResult()).toLowerCase()).toContain('ols');
  });

  it('uses "aumenta" for positive coefficients', () => {
    expect(interpret(makeResult({ coefficients: [2], pValues: [0.5, 0.01] }))).toContain('aumenta');
  });

  it('uses "disminuye" for negative coefficients', () => {
    expect(interpret(makeResult({ coefficients: [-3], pValues: [0.5, 0.01] }))).toContain('disminuye');
  });

  it('marks non-significant coefficients accordingly', () => {
    const text = interpret(makeResult({ pValues: [0.5, 0.8] }));
    expect(text).toContain('no significativo');
  });

  it('returns a non-empty string', () => {
    expect(interpret(makeResult()).length).toBeGreaterThan(0);
  });
});
