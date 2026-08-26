import { describe, expect, it } from 'vitest';
import {
  buildModelDoctor,
  engineFindingFromInterpretation,
  type EngineFinding,
  type ModelContext,
} from '../src/modelDoctor';
import {
  interpretADF,
  interpretAcfPacf,
  interpretBreuschPagan,
  interpretCoefficient,
  interpretForecast,
  interpretLjungBox,
  interpretModelFit,
  interpretResiduals,
  interpretVIF,
} from '../src/interpretation';

function context(overrides: Partial<ModelContext> = {}): ModelContext {
  return {
    mode: 'regression',
    engine: 'lite',
    nObs: 120,
    droppedRows: 0,
    paramCount: 4,
    hasIntercept: true,
    standardErrorType: 'classic',
    hacMaxLags: null,
    functionalForm: 'lin-lin',
    hasCategorical: false,
    droppedFeatures: [],
    hasRestriction: false,
    binaryTarget: false,
    datasetHasDates: false,
    alpha: 0.05,
    rSquared: 0.7,
    converged: true,
    ...overrides,
  };
}

function findings(...items: ReturnType<typeof interpretBreuschPagan>[]): EngineFinding[] {
  return items.map(engineFindingFromInterpretation);
}

describe('Model Doctor: contrato y reglas combinadas', () => {
  it('R1 convierte BP significativo con EE clásicos en un problema de inferencia', () => {
    const report = buildModelDoctor(findings(
      interpretBreuschPagan({ statistic: 12.84, pValue: 0.005, nObs: 120 })
    ), context());
    const inference = report.findings.find(item => item.category === 'inference');
    expect(inference?.state).toBe('problem');
    expect(inference?.appliedRules).toContain('R1');
    expect(inference?.headlineText).toContain('errores estándar');
    expect(inference?.detail.whyItMatters).toContain('coeficientes puntuales');
  });

  it.each(['HC1', 'HC3', 'HAC'] as const)('R2 marca heterocedasticidad mitigada con %s', standardErrorType => {
    const report = buildModelDoctor(findings(
      interpretBreuschPagan({ statistic: 12.84, pValue: 0.005, nObs: 120 })
    ), context({ standardErrorType }));
    const hetero = report.findings.find(item => item.category === 'heteroskedasticity');
    expect(hetero?.state).toBe('mitigated');
    expect(hetero?.appliedRules).toContain('R2');
    expect(report.headline?.category).not.toBe('heteroskedasticity');
  });

  it('R3 combina F global significativo, VIF y coeficientes individuales imprecisos', () => {
    const items = [
      interpretModelFit({ rSquared: 0.75, adjustedRSquared: 0.73, fStatistic: 14, fPValue: 0.001, nObs: 120 }),
      interpretVIF({ variable: 'x1', value: 12 }),
      interpretCoefficient({ name: 'x1', estimate: 1, pValue: 0.2, nObs: 120 }),
      interpretCoefficient({ name: 'x2', estimate: 1, pValue: 0.3, nObs: 120 }),
      interpretCoefficient({ name: 'x3', estimate: 1, pValue: 0.01, nObs: 120 }),
    ].map(engineFindingFromInterpretation);
    const report = buildModelDoctor(items, context());
    const multi = report.findings.find(item => item.category === 'multicollinearity');
    expect(multi?.appliedRules).toContain('R3');
    expect(multi?.impact).toBe('efficiency');
    expect(multi?.detail.whatToCheck.map(item => item.text).join(' ')).toContain('No descartar variables solo por VIF');
  });

  it('R4 prioriza no estacionariedad en niveles y explicita regresión espuria', () => {
    const report = buildModelDoctor([
      engineFindingFromInterpretation(interpretADF({ statistic: -1.2, pValue: 0.55, nObs: 100 })),
      engineFindingFromInterpretation(interpretAcfPacf({ significantAcfLags: [1, 2], significantPacfLags: [1], observations: 100 })),
    ], context({
      mode: 'timeseries',
      engine: 'pro',
      timeSeries: { transformation: 'original', arimaOrders: { p: 1, d: 0, q: 0 }, forecastHorizon: null },
    }));
    expect(report.overallState).toBe('attention');
    expect(report.headline?.category).toBe('stationarity');
    expect(report.headline?.headlineText).toContain('espurias');
    expect(report.headline?.appliedRules).toContain('R4');
  });

  it('R4 reconoce una transformación como mitigación sin afirmar que el problema desapareció', () => {
    const report = buildModelDoctor([
      engineFindingFromInterpretation(interpretADF({ statistic: -1.2, pValue: 0.55, nObs: 100 })),
    ], context({
      mode: 'timeseries',
      timeSeries: { transformation: 'difference', arimaOrders: null, forecastHorizon: null },
    }));
    const stationarity = report.findings.find(item => item.category === 'stationarity');
    expect(stationarity?.state).toBe('mitigated');
    expect(stationarity?.detail.whyItMatters).toContain('no garantiza estacionariedad');
  });

  it('R5 distingue Ljung-Box de la serie y de los residuos ARIMA', () => {
    const report = buildModelDoctor([
      engineFindingFromInterpretation(interpretADF({ statistic: -4, pValue: 0.001, nObs: 100 })),
      engineFindingFromInterpretation(interpretLjungBox({ lag: 12, statistic: 30, pValue: 0.001, residuals: false })),
      engineFindingFromInterpretation(interpretLjungBox({ lag: 12, statistic: 22, pValue: 0.01, residuals: true })),
    ], context({
      mode: 'timeseries',
      engine: 'pro',
      timeSeries: { transformation: 'difference', arimaOrders: { p: 1, d: 1, q: 1 }, forecastHorizon: 8 },
    }));
    expect(report.findings.find(item => item.category === 'serialCorrelation')?.state).toBe('ok');
    const model = report.findings.find(item => item.category === 'modelIdentification');
    expect(model?.state).toBe('problem');
    expect(model?.appliedRules).toContain('R5');
  });

  it('R10 siempre encabeza cuando el motor descartó columnas', () => {
    const report = buildModelDoctor([], context({ droppedFeatures: ['x_dup'] }));
    expect(report.headline?.category).toBe('specification');
    expect(report.headline?.appliedRules).toContain('R10');
    expect(report.overallState).toBe('attention');
  });

  it('R11 reporta exclusión masiva en el encabezado de muestra', () => {
    const report = buildModelDoctor([], context({ nObs: 60, droppedRows: 40 }));
    const sample = report.findings.find(item => item.category === 'sample');
    expect(sample?.state).toBe('problem');
    expect(sample?.impact).toBe('estimation');
    expect(sample?.appliedRules).toContain('R11');
    expect(sample?.detail.evidence.map(item => item.value).join(' ')).toContain('40.0%');
  });

  it('trata una media residual no nula con intercepto como resultado inválido, no como culpa del usuario', () => {
    const report = buildModelDoctor([
      engineFindingFromInterpretation(interpretResiduals([1, 2, 3])),
    ], context());
    const residuals = report.findings.find(item => item.category === 'residuals');
    expect(residuals?.state).toBe('problem');
    expect(residuals?.detail.whyItMatters).toContain('error de cálculo');
  });

  it('R12 declara autocorrelación no evaluada cuando una regresión usa datos con fechas', () => {
    const report = buildModelDoctor([], context({ datasetHasDates: true }));
    const serial = report.findings.find(item => item.category === 'serialCorrelation');
    expect(serial?.state).toBe('insufficient');
    expect(serial?.appliedRules).toContain('R12');
    expect(serial?.detail.conclusion).toContain('flujo de corte transversal');
    expect(report.findings.find(item => item.category === 'inference')?.state).toBe('insufficient');
  });

  it('un horizonte mayor al 20% de la muestra queda en revisión', () => {
    const report = buildModelDoctor([
      engineFindingFromInterpretation(interpretADF({ statistic: -4, pValue: 0.001, nObs: 100 })),
      engineFindingFromInterpretation(interpretAcfPacf({ significantAcfLags: [], significantPacfLags: [], observations: 100 })),
      engineFindingFromInterpretation(interpretLjungBox({ lag: 10, statistic: 5, pValue: 0.8, residuals: true })),
      engineFindingFromInterpretation(interpretForecast({ steps: 25, confidenceLevel: 0.95, hasIntervals: true })),
    ], context({
      mode: 'timeseries', engine: 'pro', nObs: 100,
      timeSeries: { transformation: 'difference', arimaOrders: { p: 1, d: 1, q: 1 }, forecastHorizon: 25 },
    }));
    expect(report.findings.find(item => item.category === 'forecast')?.state).toBe('review');
    expect(report.findings.find(item => item.category === 'forecast')?.headlineText).toContain('20%');
  });

  it('con Y binaria trata la heterocedasticidad como esperable, sin perder la advertencia de inferencia', () => {
    const report = buildModelDoctor(findings(
      interpretBreuschPagan({ statistic: 12, pValue: 0.001, nObs: 100 })
    ), context({ binaryTarget: true }));
    expect(report.findings.find(item => item.category === 'heteroskedasticity')?.impact).toBe('reading');
    expect(report.findings.find(item => item.category === 'heteroskedasticity')?.headlineText).toContain('esperable');
    expect(report.findings.find(item => item.category === 'inference')?.state).toBe('problem');
  });

  it('trata p cerca de alpha como evidencia de frontera, a ambos lados', () => {
    for (const pValue of [0.049, 0.051]) {
      const report = buildModelDoctor(findings(
        interpretBreuschPagan({ statistic: 4, pValue, nObs: 100 })
      ), context());
      const hetero = report.findings.find(item => item.category === 'heteroskedasticity');
      expect(hetero?.evidence).toBe('borderline');
      expect(hetero?.state).toBe('review');
    }
  });

  it('normaliza severidades desconocidas a revisión con confianza baja', () => {
    const report = buildModelDoctor([{
      id: 'future', category: 'future_category', severity: 'mystery', summary: 'Resultado futuro',
      limitations: [], recommendedChecks: [], recommendations: [], theoryConcepts: [],
    }], context());
    const other = report.findings.find(item => item.category === 'other');
    expect(other?.state).toBe('review');
    expect(other?.confidence).toBe('low');
  });

  it('es determinístico e incluye recomendaciones y teoría en toda revisión o problema', () => {
    const input = [engineFindingFromInterpretation(interpretVIF({ variable: 'x', value: 6 }))];
    const first = buildModelDoctor(input, context());
    const second = buildModelDoctor(input, context());
    expect(second).toEqual(first);
    for (const item of first.findings.filter(finding => finding.state === 'review' || finding.state === 'problem')) {
      expect(item.detail.whatToCheck.length).toBeGreaterThan(0);
      expect(item.detail.theory.length).toBeGreaterThan(0);
    }
  });

  it('no presenta categorías del flujo contrario y nunca pinta insuficiencia como ok', () => {
    const report = buildModelDoctor([], context({
      mode: 'timeseries',
      timeSeries: { transformation: 'original', arimaOrders: null, forecastHorizon: null },
    }));
    expect(report.findings.some(item => item.category === 'heteroskedasticity')).toBe(false);
    expect(report.findings.filter(item => item.insufficientReason).every(item => item.state === 'insufficient')).toBe(true);
  });

  it('propaga un prerrequisito insuficiente a sus dependientes', () => {
    const report = buildModelDoctor([
      engineFindingFromInterpretation(interpretAcfPacf({ significantAcfLags: [1], significantPacfLags: [1], observations: 80 })),
    ], context({
      mode: 'timeseries',
      timeSeries: { transformation: 'original', arimaOrders: { p: 1, d: 0, q: 1 }, forecastHorizon: 6 },
    }));
    expect(report.findings.find(item => item.category === 'stationarity')?.state).toBe('insufficient');
    expect(report.findings.find(item => item.category === 'modelIdentification')?.state).toBe('insufficient');
    expect(report.findings.find(item => item.category === 'forecast')?.insufficientReason).toBe('dependency_unmet');
  });

  it('con n chico y cobertura limitada evita un estado general engañosamente claro', () => {
    const report = buildModelDoctor([], context({ nObs: 15, paramCount: 2 }));
    expect(report.overallState).toBe('partial');
    expect(report.coverage.evaluated).toBeLessThan(report.coverage.applicable);
  });

  it('si el modelo no converge muestra un solo bloque y ningún ok', () => {
    const report = buildModelDoctor([], context({ converged: false }));
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].state).toBe('problem');
    expect(report.findings.some(item => item.state === 'ok')).toBe(false);
  });
});
