import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Content test for the "Aprender" area (web/templates/guia.html). The learn
// area is a Flask template outside the bundler, so — like liteIsolation.test.ts
// — this test reads the file straight from disk. It guards two things:
//   1. every required pedagogical topic is present, and
//   2. the honesty rules hold (no stale "Roadmap" for shipped features, no
//      causal overclaiming, auto-ARIMA still marked as not implemented).

const GUIA_HTML = readFileSync(
  join(__dirname, '..', '..', 'web', 'templates', 'guia.html'),
  'utf8'
);

// The Aprender tab panel specifically (not the whole page).
const aprenderStart = GUIA_HTML.indexOf('id="area-aprender"');
const aprenderEnd = GUIA_HTML.indexOf('</section>', aprenderStart);
const APRENDER = GUIA_HTML.slice(aprenderStart, aprenderEnd);

describe('Área Aprender (guia.html)', () => {
  it('exists as a tab panel in the guide', () => {
    expect(aprenderStart).toBeGreaterThan(-1);
    expect(APRENDER.length).toBeGreaterThan(1000);
  });

  it.each([
    ['modelo econométrico', 'Que es un modelo econometrico'],
    ['OLS', 'Regresion lineal (OLS)'],
    ['RLS', 'Restricciones lineales (RLS)'],
    ['formas funcionales', 'Formas funcionales'],
    ['dummies', 'Variables dummy'],
    ['errores robustos', 'Errores estandar y errores robustos'],
    ['heterocedasticidad', 'Heterocedasticidad'],
    ['Breusch-Pagan', 'Breusch-Pagan'],
    ['series de tiempo', 'Que es una serie de tiempo'],
    ['orden temporal', 'Orden temporal y frecuencia'],
    ['ADF', 'ADF (raiz unitaria)'],
    ['ACF/PACF', 'ACF y PACF'],
    ['Ljung-Box', 'Ljung-Box'],
    ['ARIMA', '<summary>ARIMA</summary>'],
    ['forecast', '<summary>Forecast</summary>'],
    ['fechas reales', 'Fechas reales'],
  ])('covers %s', (_topic, marker) => {
    expect(APRENDER).toContain(marker);
  });

  it('explains the econometric model with dependent variable, error term and the consumo example', () => {
    expect(APRENDER).toContain('Variable dependiente');
    expect(APRENDER).toContain('termino de error');
    expect(APRENDER).toContain('consumo');
    expect(APRENDER).toContain('ingreso');
  });

  it('explains the four functional forms with their interpretations and log domain', () => {
    expect(APRENDER).toContain('Lin-Lin');
    expect(APRENDER).toContain('Log-Lin');
    expect(APRENDER).toContain('Lin-Log');
    expect(APRENDER).toContain('Log-Log');
    expect(APRENDER).toContain('elasticidad');
    expect(APRENDER).toContain('requieren valores positivos');
  });

  it('explains dummies with base category and the dummy trap', () => {
    expect(APRENDER).toContain('trampa de dummies');
    expect(APRENDER).toContain('region_Norte');
    expect(APRENDER).toContain('region_Centro');
  });

  it('explains robust errors (classic/HC1/HC3) without claiming they change the betas', () => {
    expect(APRENDER).toContain('HC1');
    expect(APRENDER).toContain('HC3');
    expect(APRENDER).toContain('No cambian los coeficientes OLS');
  });

  it('explains Breusch-Pagan with H0 and the 5% reading', () => {
    expect(APRENDER).toContain('H0: homocedasticidad');
    expect(APRENDER).toContain('p &lt; 0.05');
  });

  it('explains ARIMA p/d/q with the ARIMA(1,1,1) example and the honesty note', () => {
    expect(APRENDER).toContain('ARIMA(1,1,1)');
    expect(APRENDER).toContain('ARIMA no adivina el futuro');
  });

  it('explains forecast with horizon, intervals and why they widen', () => {
    expect(APRENDER).toContain('pronostico puntual');
    expect(APRENDER).toContain('abrirse a medida que crece el horizonte');
    expect(APRENDER).toContain('no es una promesa');
  });

  it('explains real dates, frequency inference and generic forecast fallback', () => {
    expect(APRENDER).toContain('ChartBay puede ordenar la serie por fecha');
    expect(APRENDER).toContain('frecuencia temporal estable');
    expect(APRENDER).toContain('no inventa fechas');
    expect(APRENDER).toContain('t+1, t+2');
  });

  it('includes the pedagogical microcopy phrases', () => {
    expect(APRENDER).toContain('asociacion estimada, no una verdad universal');
    expect(APRENDER).toContain('no convierte automaticamente una relacion en causal');
    expect(APRENDER).toContain('Antes de usar ARIMA');
    expect(APRENDER).toContain('La categoria base no desaparece');
    expect(APRENDER).toContain('no arreglan el modelo; ajustan la inferencia');
  });

  it('does not mark shipped features (ARIMA, Breusch-Pagan) as Roadmap anymore', () => {
    // Roadmap must not appear inside the ARIMA/forecast/BP subsections except
    // for auto-ARIMA, which is honestly still unimplemented.
    expect(APRENDER).not.toContain('Modelos AR / MA / ARIMA');
    expect(APRENDER).toContain('Auto-ARIMA');
    expect(APRENDER).not.toContain('Test dedicado: <span class="guia-st road">Roadmap</span>');
  });

  it('keeps the glossary updated with the new concepts', () => {
    expect(APRENDER).toContain('<strong>Dummy.</strong>');
    expect(APRENDER).toContain('<strong>Breusch-Pagan.</strong>');
    expect(APRENDER).toContain('<strong>ARIMA(p,d,q).</strong>');
    expect(APRENDER).toContain('<strong>Forecast.</strong>');
    expect(APRENDER).toContain('<strong>Indice temporal.</strong>');
    expect(APRENDER).toContain('<strong>Frecuencia temporal.</strong>');
  });
});
