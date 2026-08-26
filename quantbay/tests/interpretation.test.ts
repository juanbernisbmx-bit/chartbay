import { describe, expect, it } from 'vitest';
import type { RegressionResult } from '../src/regression';
import {
  interpret,
  interpretADF,
  interpretAcfPacf,
  interpretArima,
  interpretBreuschPagan,
  interpretCoefficient,
  interpretFTest,
  interpretForecast,
  interpretLjungBox,
  interpretModelFit,
  interpretPValue,
  interpretRegressionResult,
  interpretResiduals,
  interpretResult,
  interpretVIF,
  interpretWald,
  normalizeAlpha,
} from '../src/interpretation';

function makeResult(overrides: Partial<RegressionResult> = {}): RegressionResult {
  return {
    coefficients: [2], intercept: 1, rSquared: 0.85, adjustedRSquared: 0.83,
    predictions: [3, 5, 7], residuals: [0.1, -0.1, 0], equation: 'y = 1 + 2·x',
    featureNames: ['x'], yName: 'y', nObs: 10, nFeatures: 1,
    stdErrors: [0.5, 0.3], tStats: [2, 6.67], pValues: [0.07, 0.001],
    ci95: [[0.1, 1.9], [1.5, 2.5]], df: 8, sigma2: 0.5,
    fStat: 44.44, fPValue: 0.0003, ...overrides,
  };
}

describe('alpha y p-values', () => {
  it.each([0.1, 0.05, 0.01])('respeta alpha = %s', alpha => {
    expect(normalizeAlpha(alpha)).toBe(alpha);
    expect(interpretPValue(alpha / 2, alpha).reject).toBe(true);
    expect(interpretPValue(alpha * 2, alpha).reject).toBe(false);
  });

  it('rechaza cuando p-value es exactamente alpha y documenta la decisión', () => {
    const result = interpretPValue(0.05, 0.05);
    expect(result.reject).toBe(true);
    expect(result.conclusion).toBe('Con α = 0.05, existe evidencia estadística suficiente para rechazar H₀.');
  });

  it('no acepta H0 cuando no rechaza', () => {
    const text = interpretPValue(0.2, 0.05).conclusion;
    expect(text).toContain('no existe evidencia estadística suficiente');
    expect(text.toLowerCase()).not.toContain('acept');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1, null])('marca p inválido: %s', p => {
    expect(interpretPValue(p as number | null, 0.05).available).toBe(false);
  });
});

describe('coeficientes y formas funcionales', () => {
  const base = { name: 'educación', estimate: 0.082, pValue: 0.001, alpha: 0.05 };

  it('separa signo, significancia y causalidad', () => {
    const result = interpretCoefficient(base);
    expect(result.summary).toContain('positivo');
    expect(result.summary).toContain('estadísticamente significativo');
    expect(result.practicalMeaning).toContain('se asocia');
    expect(result.limitations.join(' ')).toContain('no demuestra causalidad');
  });

  it('interpreta nivel-nivel', () => {
    expect(interpretCoefficient({ ...base, functionalForm: 'lin-lin' }).practicalMeaning)
      .toContain('0.0820 unidades en Y');
  });

  it('interpreta log-nivel con aproximación y efecto exacto', () => {
    const text = interpretCoefficient({ ...base, functionalForm: 'log-lin' }).practicalMeaning ?? '';
    expect(text).toContain('8.20%');
    expect(text).toContain('8.55%');
  });

  it('interpreta nivel-log', () => {
    expect(interpretCoefficient({ ...base, estimate: 5, functionalForm: 'lin-log' }).practicalMeaning)
      .toContain('0.0500 unidades');
  });

  it('interpreta log-log como elasticidad', () => {
    expect(interpretCoefficient({ ...base, functionalForm: 'log-log' }).practicalMeaning)
      .toContain('elasticidad');
  });

  it('interpreta dummy contra la categoría base', () => {
    const text = interpretCoefficient({ ...base, kind: 'dummy', baseCategory: 'Centro' }).practicalMeaning ?? '';
    expect(text).toContain('categoría "Centro"');
    expect(text).not.toContain('unidad adicional');
  });

  it('no interpreta ingenuamente una interacción', () => {
    const text = interpretCoefficient({ ...base, kind: 'interaction' }).practicalMeaning ?? '';
    expect(text).toContain('no es un efecto total aislado');
    expect(text).toContain('depende');
  });

  it('maneja coeficiente cero e intervalo que contiene cero', () => {
    const result = interpretCoefficient({ ...base, estimate: 0, pValue: 1, confidenceInterval: [-0.2, 0.2] });
    expect(result.summary).toContain('igual a cero');
    expect(result.limitations.join(' ')).toContain('contiene cero');
  });

  it('prefiere insuficiencia antes que inventar con NaN', () => {
    expect(interpretCoefficient({ ...base, estimate: Number.NaN }).summary)
      .toBe('No hay información suficiente para generar una interpretación fiable.');
  });
});

describe('OLS, ajuste y contrastes', () => {
  it('interpreta R2 sin llamarlo calidad ni causalidad', () => {
    const result = interpretModelFit({ rSquared: 0.8, adjustedRSquared: 0.76, fStatistic: 10, fPValue: 0.01 });
    expect(result.summary).toContain('80.0% de la variación muestral');
    expect(result.practicalMeaning).toContain('penaliza');
    expect(result.limitations.join(' ')).toContain('no demuestra causalidad');
    expect(result.summary).not.toMatch(/bueno|malo|mejor/);
  });

  it('explicita la H0 del F global', () => {
    expect(interpretFTest({ statistic: 5.2, pValue: 0.02 }).statisticalConclusion)
      .toContain('pendientes son conjuntamente iguales a cero');
  });

  it('Wald rechazado no invalida todo el modelo', () => {
    const result = interpretWald({ statistic: 8, pValue: 0.01, restrictions: 2, hypothesis: 'β1 + β2 = 1' });
    expect(result.practicalMeaning).toContain('no invalida automáticamente');
  });

  it('Wald no rechazado no demuestra la restricción', () => {
    expect(interpretWald({ statistic: 1, pValue: 0.4 }).practicalMeaning).toContain('no la demuestra verdadera');
  });

  it('adapta OLS completo y conserva API textual', () => {
    const structured = interpretRegressionResult(makeResult(), { functionalForm: 'lin-lin' });
    expect(structured.map(item => item.id)).toEqual(['model-fit', 'coefficient:x', 'residuals']);
    expect(interpret(makeResult())).toContain('85.0%');
    expect(interpret(makeResult())).toContain('"x"');
  });

  it('trata nombres extraños como datos, no como sintaxis', () => {
    const result = interpretCoefficient({ name: '<precio & dólar>', estimate: 2, pValue: 0.03 });
    expect(result.id).toContain('<precio & dólar>');
  });
});

describe('diagnósticos', () => {
  it('interpreta BP rechazado con consecuencia precisa', () => {
    const result = interpretBreuschPagan({ statistic: 8.42, pValue: 0.012, alpha: 0.05 });
    expect(result.summary).toContain('heterocedasticidad');
    expect(result.practicalMeaning).toContain('OLS puede seguir siendo insesgado');
    expect(result.nextSteps.map(step => step.label).join(' ')).toContain('HC1/HC3');
  });

  it('BP no rechazado no demuestra homocedasticidad', () => {
    expect(interpretBreuschPagan({ statistic: 1, pValue: 0.5 }).practicalMeaning)
      .toContain('no demuestra homocedasticidad');
  });

  it.each([[1.1, 'cercano a 1'], [6, 'moderado'], [12, 'elevado']] as const)('VIF %s usa categoría %s', (value, band) => {
    expect(interpretVIF({ variable: 'x', value }).summary).toContain(band);
  });

  it('VIF documenta umbrales como heurísticas y no sesgo', () => {
    const text = interpretVIF({ variable: 'x', value: 11 }).limitations.join(' ');
    expect(text).toContain('reglas prácticas, no tests formales');
    expect(text).toContain('no implica automáticamente sesgo OLS');
  });

  it('residuo medio no se presenta como prueba de exogeneidad', () => {
    const result = interpretResiduals([1, -1, 0]);
    expect(result.practicalMeaning).toContain('identidad algebraica');
    expect(result.practicalMeaning).toContain('no prueba exogeneidad');
  });
});

describe('series de tiempo y forecast', () => {
  it('ADF rechazado usa lenguaje de evidencia y enlaza teoría', () => {
    const result = interpretADF({ statistic: -3.5, pValue: 0.02, criticalValues: { fivePercent: -2.9 }, alpha: 0.05 });
    expect(result.summary).toContain('evidencia');
    expect(result.summary).not.toContain('demuestra');
    expect(result.theoryConcepts).toContain('teoria-adf');
  });

  it('ADF no rechazado no confirma raíz unitaria', () => {
    expect(interpretADF({ statistic: -1, pValue: 0.5 }).limitations.join(' '))
      .toContain('No rechazar H₀ no confirma');
  });

  it('ADF prioriza crítico disponible para alpha soportado', () => {
    const result = interpretADF({ statistic: -3, pValue: 0.2, criticalValues: { fivePercent: -2.9 }, alpha: 0.05 });
    expect(result.statisticalConclusion).toContain('comparación con el valor crítico');
    expect(result.summary).toContain('rechazar');
  });

  it('Ljung-Box rechazado detecta autocorrelación residual conjunta', () => {
    expect(interpretLjungBox({ lag: 10, statistic: 20, pValue: 0.01, residuals: true }).summary)
      .toContain('autocorrelación residual conjunta');
  });

  it('Ljung-Box no rechazado no declara white noise perfecto', () => {
    const result = interpretLjungBox({ lag: 10, statistic: 5, pValue: 0.8 });
    expect(result.practicalMeaning).toContain('no una prueba de ruido blanco perfecto');
  });

  it('ACF/PACF es orientativo, no identifica AR(2)', () => {
    const result = interpretAcfPacf({ significantAcfLags: [1, 2], significantPacfLags: [1], observations: 100 });
    expect(result.practicalMeaning).toContain('no identifican automáticamente');
    expect(result.practicalMeaning).not.toContain('es AR(2)');
  });

  it('ACF/PACF no presenta una conclusión favorable sin muestra suficiente', () => {
    const result = interpretAcfPacf({ significantAcfLags: [], significantPacfLags: [], observations: 0 });
    expect(result.applicability).toBe('unavailable');
    expect(result.unavailableReason).toBe('sample_too_small');
    expect(result.severity).toBe('neutral');
    expect(result.summary).toContain('menos de 4 observaciones');
    expect(result.summary).not.toContain('No se observan rezagos');
  });

  it('ARIMA separa predicción de causalidad y advierte no convergencia', () => {
    const result = interpretArima({ p: 1, d: 1, q: 1, converged: false });
    expect(result.summary).toContain('1 término(s) AR');
    expect(result.practicalMeaning).toContain('no proporciona una explicación causal');
    expect(result.severity).toBe('critical');
  });

  it('forecast explica incertidumbre predictiva', () => {
    const result = interpretForecast({ steps: 12, confidenceLevel: 0.95, hasIntervals: true });
    expect(result.summary).toContain('intervalos al 95%');
    expect(result.practicalMeaning).toContain('incertidumbre predictiva');
  });

  it('dispatcher produce el mismo intérprete tipado', () => {
    expect(interpretResult({ type: 'vif', result: { variable: 'x', value: 2 } }).id).toBe('vif:x');
  });
});
