import { describe, expect, it } from 'vitest';
import { fitOlsQr } from '../src/qrLeastSquares';
import { runOLS } from '../src/regression';
import { loadFixture } from './fixtures/loadFixture';

interface OlsFixture {
  data: { X: number[][]; y: number[] };
  expected: { params: number[]; stdErrors: number[]; tStats: number[]; df: number };
}

const fx = loadFixture<OlsFixture>('ols_multiple_statsmodels.json');

function closeTo(actual: number, expected: number, tol: number): boolean {
  return Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected));
}

describe('fitOlsQr contra statsmodels', () => {
  it('reproduce coeficientes, errores estándar y t de un diseño normal', () => {
    const fit = fitOlsQr(fx.data.X, fx.data.y);
    expect(fit).not.toBeNull();

    expect(fit!.residualDegreesOfFreedom).toBe(fx.expected.df);
    for (let i = 0; i < fx.expected.params.length; i++) {
      expect(closeTo(fit!.coefficients[i], fx.expected.params[i], 1e-9)).toBe(true);
      expect(closeTo(fit!.standardErrors[i], fx.expected.stdErrors[i], 1e-9)).toBe(true);
      expect(closeTo(fit!.tStats[i], fx.expected.tStats[i], 1e-9)).toBe(true);
    }
  });

  it('la posición 0 es el intercepto, igual que en runOLS', () => {
    // El ADF lee tStats[1] para quedarse con el nivel rezagado, así que el
    // orden tiene que coincidir con el del estimador de siempre.
    const fit = fitOlsQr(fx.data.X, fx.data.y)!;
    const ols = runOLS({ X: fx.data.X, y: fx.data.y, featureNames: ['x1', 'x2'], yName: 'y' });

    expect(closeTo(fit.coefficients[0], ols.intercept, 1e-9)).toBe(true);
    expect(closeTo(fit.coefficients[1], ols.coefficients[0], 1e-9)).toBe(true);
    expect(closeTo(fit.tStats[1], ols.tStats[1], 1e-9)).toBe(true);
  });
});

describe('fitOlsQr en los bordes', () => {
  it('devuelve null con colinealidad perfecta en vez de tirar', () => {
    const X = Array.from({ length: 12 }, (_, i) => [i + 1, 2 * (i + 1)]);
    const y = X.map(row => row[0] * 3 + 1);
    expect(fitOlsQr(X, y)).toBeNull();
  });

  it('devuelve null cuando no hay grados de libertad', () => {
    expect(fitOlsQr([[1], [2]], [1, 2])).toBeNull();
  });

  it('aguanta el diseño mal condicionado que rompía las ecuaciones normales', () => {
    // Niveles de tres cifras contra diferencias de una: es la forma del diseño
    // del ADF, donde X'X eleva al cuadrado un condicionamiento ya malo.
    const niveles = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(0.02 * i));
    const y = niveles.slice(1).map((v, i) => v - niveles[i]);
    const X = y.map((_, i) => [niveles[i], i + 1]);

    const fit = fitOlsQr(X, y)!;
    expect(fit).not.toBeNull();
    // El ajuste tiene que reproducir y: residuos chicos frente a la escala.
    const escala = Math.max(...y.map(Math.abs));
    for (const r of fit.residuals) expect(Math.abs(r)).toBeLessThan(escala * 1e-6);
  });
});
