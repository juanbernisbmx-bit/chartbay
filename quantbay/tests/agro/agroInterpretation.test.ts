import { describe, expect, it } from 'vitest';
import {
  fromRegressionResult,
  interpretAgroRegressionResult,
  type ModelRunResultLike,
} from '../../src/verticals/agro/agroInterpretation';
import type { AgroInterpretationContext } from '../../src/verticals/agro/agroTypes';
import { runOLS } from '../../src/regression';

function baseResult(overrides: Partial<ModelRunResultLike> = {}): ModelRunResultLike {
  return {
    coefficients: [{ name: 'lluvia_mm', estimate: 2.5, pValue: 0.01 }],
    rSquared: 0.72,
    adjustedRSquared: 0.7,
    observations: 48,
    warnings: [],
    functionalForm: 'lin-lin',
    ...overrides,
  };
}

function yieldContext(overrides: Partial<AgroInterpretationContext> = {}): AgroInterpretationContext {
  return {
    form: 'lin-lin',
    targetColumn: 'rinde_kg_ha',
    targetRole: 'yield',
    columnRoles: { lluvia_mm: 'rainfall' },
    crop: 'soja',
    ...overrides,
  };
}

describe('interpretAgroRegressionResult', () => {
  it('interpreta lin-lin como efecto marginal en unidades', () => {
    const interpretation = interpretAgroRegressionResult(baseResult(), yieldContext());
    expect(interpretation.coefficientReadings).toHaveLength(1);
    expect(interpretation.coefficientReadings[0]).toContain('1 unidad');
    expect(interpretation.coefficientReadings[0]).toContain('2.5000');
    expect(interpretation.executiveSummary).toContain('72.0%');
    expect(interpretation.executiveSummary).toContain('rinde_kg_ha');
  });

  it('interpreta log-log como elasticidad', () => {
    const result = baseResult({
      coefficients: [{ name: 'precio_chicago_usd_tn', estimate: 0.85, pValue: 0.001 }],
      functionalForm: 'log-log',
    });
    const context = yieldContext({
      form: 'log-log',
      targetColumn: 'precio_local_usd_tn',
      targetRole: 'price',
      columnRoles: { precio_chicago_usd_tn: 'price' },
    });
    const interpretation = interpretAgroRegressionResult(result, context);
    expect(interpretation.coefficientReadings[0]).toContain('elasticidad');
    expect(interpretation.coefficientReadings[0]).toContain('1%');
  });

  it('genera lectura específica lluvia-rinde', () => {
    const interpretation = interpretAgroRegressionResult(baseResult(), yieldContext());
    expect(interpretation.agroReading).toContain('Lluvia y rinde');
    expect(interpretation.agroReading).toContain('rindes más altos');
    expect(interpretation.agroReading).toContain('kg/ha');
  });

  it('genera lectura específica tipo de cambio-precio', () => {
    const result = baseResult({
      coefficients: [{ name: 'tipo_cambio', estimate: 0.12, pValue: 0.03 }],
    });
    const context = yieldContext({
      targetColumn: 'precio_local',
      targetRole: 'price',
      columnRoles: { tipo_cambio: 'exchange_rate' },
    });
    const interpretation = interpretAgroRegressionResult(result, context);
    expect(interpretation.agroReading).toContain('sensibilidad del precio local al dólar');
  });

  it('genera lectura de transmisión internacional y de escala productiva', () => {
    const transmission = interpretAgroRegressionResult(
      baseResult({ coefficients: [{ name: 'chicago', estimate: 0.8 }] }),
      yieldContext({ targetRole: 'price', targetColumn: 'precio', columnRoles: { chicago: 'price' } })
    );
    expect(transmission.agroReading).toContain('Transmisión internacional');

    const scale = interpretAgroRegressionResult(
      baseResult({ coefficients: [{ name: 'superficie_sembrada', estimate: 3.1 }] }),
      yieldContext({
        targetRole: 'production',
        targetColumn: 'produccion_tn',
        columnRoles: { superficie_sembrada: 'area_planted' },
      })
    );
    expect(scale.agroReading).toContain('Escala productiva');
  });

  it('remarca el impacto negativo esperado de costo sobre margen', () => {
    const negative = interpretAgroRegressionResult(
      baseResult({ coefficients: [{ name: 'costo_total', estimate: -0.9, pValue: 0.02 }] }),
      yieldContext({ targetRole: 'margin', targetColumn: 'margen_bruto', columnRoles: { costo_total: 'cost' } })
    );
    expect(negative.agroReading).toContain('negativo');
    expect(negative.agroReading).toContain('esperado');

    const positive = interpretAgroRegressionResult(
      baseResult({ coefficients: [{ name: 'costo_total', estimate: 0.4 }] }),
      yieldContext({ targetRole: 'margin', targetColumn: 'margen_bruto', columnRoles: { costo_total: 'cost' } })
    );
    expect(positive.agroReading).toContain('lo contrario a lo esperado');
  });

  it('agrega warning con pocas observaciones', () => {
    const interpretation = interpretAgroRegressionResult(
      baseResult({ observations: 14 }),
      yieldContext()
    );
    expect(interpretation.warnings.some(w => w.includes('Muestra chica (n = 14)'))).toBe(true);
  });

  it('no agrega warning de muestra chica con n suficiente', () => {
    const interpretation = interpretAgroRegressionResult(baseResult({ observations: 60 }), yieldContext());
    expect(interpretation.warnings.some(w => w.includes('Muestra chica'))).toBe(false);
  });

  it('preserva warnings del modelo original', () => {
    const interpretation = interpretAgroRegressionResult(
      baseResult({ warnings: ['Colinealidad alta entre lluvia y napa.'] }),
      yieldContext()
    );
    expect(interpretation.warnings).toContain('Colinealidad alta entre lluvia y napa.');
  });

  it('siempre advierte que correlación no implica causalidad e incluye limitaciones', () => {
    const interpretation = interpretAgroRegressionResult(baseResult(), yieldContext());
    expect(interpretation.warnings[0]).toContain('Correlación no implica causalidad');
    expect(interpretation.limitations.length).toBeGreaterThanOrEqual(3);
    expect(interpretation.limitations.join(' ')).toContain('Variables omitidas');
  });

  it('marca coeficientes no significativos', () => {
    const interpretation = interpretAgroRegressionResult(
      baseResult({ coefficients: [{ name: 'lluvia_mm', estimate: 1.2, pValue: 0.4 }] }),
      yieldContext()
    );
    expect(interpretation.coefficientReadings[0]).toContain('no significativo');
  });
});

describe('fromRegressionResult (adapter del motor común)', () => {
  it('adapta un RegressionResult real de runOLS sin tocar el core', () => {
    // y ≈ 2x + 1 con ruido chico: el motor común estima, Agro sólo interpreta.
    const ols = runOLS({
      X: [[1], [2], [3], [4], [5], [6]],
      y: [3.1, 4.9, 7.2, 9.1, 10.8, 13.2],
      featureNames: ['lluvia_mm'],
      yName: 'rinde_kg_ha',
    });
    const adapted = fromRegressionResult(ols, 'lin-lin');
    expect(adapted.coefficients).toHaveLength(1);
    expect(adapted.coefficients[0].name).toBe('lluvia_mm');
    expect(adapted.coefficients[0].estimate).toBeCloseTo(ols.coefficients[0], 12);
    expect(adapted.coefficients[0].pValue).toBe(ols.pValues[1]);
    expect(adapted.observations).toBe(6);

    const interpretation = interpretAgroRegressionResult(adapted, yieldContext());
    expect(interpretation.agroReading).toContain('Lluvia y rinde');
    expect(interpretation.warnings.some(w => w.includes('Muestra chica'))).toBe(true);
  });
});
