import { describe, expect, it } from 'vitest';
import { adfCriticalValues, adfPValue, computeADF } from '../../src/timeseries/adf';
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

// Referencias de statsmodels.tsa.adfvalues.mackinnonp(t, regression='c', N=1).
const P_REFERENCIA: Array<[number, number]> = [
  [-20.0, 0.0],
  [-18.83, 2.0221237233452862e-30],
  [-6.0, 1.666120483405439e-07],
  [-3.5443688564814813, 0.006918098467289275],
  [-2.9110731481481484, 0.04407541048188462],
  [-2.0, 0.28657309916843154],
  [-1.61, 0.4779756525941893],
  [-1.0, 0.7532643012005655],
  [0.0, 0.958532086060056],
  [2.0, 0.9986729511999243],
  [2.74, 0.9990880801041981],
  [4.372519, 1.0],
  [10.0, 1.0],
];

describe('p-valor del ADF contra MacKinnon (1994)', () => {
  for (const [t, esperado] of P_REFERENCIA) {
    it(`coincide con statsmodels en t = ${t}`, () => {
      const p = adfPValue(t)!;
      // Tolerancia absoluta: en las colas los valores son del orden de 1e-30 y
      // una relativa no significaría nada ahí.
      expect(Math.abs(p - esperado)).toBeLessThan(1e-12);
    });
  }

  it('se satura fuera del rango ajustado, sin inventar precisión', () => {
    expect(adfPValue(-25)).toBe(0);
    expect(adfPValue(5)).toBe(1);
  });

  it('crece con el estadístico: menos negativo es menos evidencia contra la raíz unitaria', () => {
    const orden = [-6, -4, -3, -2, -1, 0, 2].map(t => adfPValue(t)!);
    for (let i = 1; i < orden.length; i++) expect(orden[i]).toBeGreaterThan(orden[i - 1]);
  });

  it('devuelve null si el estadístico no es finito', () => {
    expect(adfPValue(Number.NaN)).toBeNull();
    expect(adfPValue(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('no coincide exactamente con los valores críticos, y por eso hay aviso', () => {
    // Los críticos son MacKinnon 2010 y ajustan por n; el p-valor es MacKinnon
    // 1994 y es asintótico. En el crítico al 5% de una muestra chica el
    // p-valor da 0.044, no 0.050, y la brecha se cierra al crecer n. Es la
    // misma asimetría que arrastra statsmodels; queda fijada acá para que no
    // se lea como un error de cálculo.
    expect(adfPValue(adfCriticalValues(60).fivePercent)!).toBeCloseTo(0.0441, 4);
    expect(adfPValue(adfCriticalValues(500).fivePercent)!).toBeCloseTo(0.0493, 4);
    expect(adfPValue(adfCriticalValues(Number.POSITIVE_INFINITY).fivePercent)!).toBeCloseTo(0.05, 3);
  });

  it('no avisa de contradicción cuando no la hay', () => {
    // El índice de precios da un estadístico muy lejos de la franja de
    // conflicto, así que el aviso no tiene que aparecer.
    const fixture = loadFixture<{ series: Record<string, { data: number[]; expected: { adfLag: number | null } }> }>(
      'time_series_statsmodels.json'
    );
    const serie = fixture.series.price_index_level;
    const result = computeADF(serie.data, serie.expected.adfLag!);
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.interpretation).not.toContain('no coinciden al 5%');
      expect(result.interpretation).toContain('MacKinnon (1994)');
    }
  });
});
