import { describe, expect, it } from 'vitest';
import { adfCriticalValues, computeADF } from '../../src/timeseries/adf';
import { loadFixture } from '../fixtures/loadFixture';

// Referencias sacadas de statsmodels.tsa.adfvalues.mackinnoncrit(N=1,
// regression='c', nobs=n), que es lo que usa adfuller para los críticos.
const REFERENCIA: Array<{ n: number; esperado: [number, number, number] }> = [
  { n: 25, esperado: [-3.7238633119999998, -2.98648896, -2.6328004] },
  { n: 60, esperado: [-3.5443688564814813, -2.9110731481481484, -2.5931902777777776] },
  { n: 100, esperado: [-3.497501033, -2.89090644, -2.5824349] },
  { n: 500, esperado: [-3.443496379464, -2.8673378563200003, -2.569858036] },
];

describe('valores críticos del ADF contra MacKinnon (2010)', () => {
  for (const { n, esperado } of REFERENCIA) {
    it(`coincide con statsmodels para n = ${n}`, () => {
      const cv = adfCriticalValues(n);
      expect(cv.onePercent).toBeCloseTo(esperado[0], 12);
      expect(cv.fivePercent).toBeCloseTo(esperado[1], 12);
      expect(cv.tenPercent).toBeCloseTo(esperado[2], 12);
    });
  }

  it('con n infinito devuelve el valor asintótico, que es lo que se usaba fijo', () => {
    const cv = adfCriticalValues(Number.POSITIVE_INFINITY);
    expect(cv.onePercent).toBeCloseTo(-3.43035, 12);
    expect(cv.fivePercent).toBeCloseTo(-2.86154, 12);
    expect(cv.tenPercent).toBeCloseTo(-2.56677, 12);
  });

  it('son más exigentes cuanto más chica la muestra', () => {
    // La cola de la distribución de Dickey-Fuller pesa más con pocas
    // observaciones: usar el asintótico ahí rechaza la raíz unitaria de más.
    const chica = adfCriticalValues(25);
    const grande = adfCriticalValues(500);
    const asintotico = adfCriticalValues(Number.POSITIVE_INFINITY);
    expect(chica.fivePercent).toBeLessThan(grande.fivePercent);
    expect(grande.fivePercent).toBeLessThan(asintotico.fivePercent);
  });
});

describe('computeADF usa el n de la regresión, no el largo de la serie', () => {
  interface SeriesFixture {
    data: number[];
    expected: { adfLag: number | null };
  }
  const fx = loadFixture<{ series: Record<string, SeriesFixture> }>(
    'time_series_statsmodels.json'
  );

  it('descuenta la diferenciación y los rezagos', () => {
    const serie = fx.series.price_index_level;
    const lag = serie.expected.adfLag!;
    const result = computeADF(serie.data, lag);

    expect(result.available).toBe(true);
    if (!result.available) return;

    // 72 observaciones, lag 11 ⇒ 60 filas en la regresión, que es el n que
    // statsmodels le pasa a mackinnoncrit.
    expect(result.observations).toBe(serie.data.length);
    expect(result.regressionObservations).toBe(serie.data.length - lag - 1);
    expect(result.criticalValues).toEqual(adfCriticalValues(result.regressionObservations));
  });
});
