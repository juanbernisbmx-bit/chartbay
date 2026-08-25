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
    ['ARIMA', '<summary>AR, MA y ARIMA</summary>'],
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
    expect(APRENDER).toContain('&beta;<sub>1</sub>/100 unidades de Y');
    expect(APRENDER).toContain('exp(&beta;<sub>1</sub>&Delta;X)-1');
    expect(APRENDER).toContain('8,33%');
  });

  it('uses quick summaries, formulas, examples, mistakes and references without adding a parallel theory system', () => {
    expect(APRENDER).toContain('class="guia-summary"');
    expect(APRENDER).toContain('class="guia-formula"');
    expect(APRENDER).toContain('class="guia-example"');
    expect(APRENDER).toContain('class="guia-mistake"');
    expect(APRENDER).toContain('class="guia-reference"');
    expect(APRENDER).toContain('Wooldridge');
  });

  it('develops the empirical workflow instead of defining econometrics in one sentence', () => {
    expect(APRENDER).toContain('De la pregunta al resultado');
    expect(APRENDER).toContain('Descripcion, prediccion y causalidad');
    expect(APRENDER).toContain('Construir un modelo economico');
    expect(APRENDER).toContain('Evaluar el modelo');
  });

  it('distinguishes population parameters, estimates, errors and residuals', () => {
    expect(APRENDER).toContain('Poblacion, muestra y estimacion');
    expect(APRENDER).toContain('Los &beta; pertenecen a la poblacion');
    expect(APRENDER).toContain('Residuo no es error');
    expect(APRENDER).toContain('Que los residuos sumen cero no demuestra');
  });

  it('explains the OLS objective, normal-equation identities and partial effects', () => {
    expect(APRENDER).toContain('min<sub>b0,...,bk</sub> SSR');
    expect(APRENDER).toContain('&Sigma;e<sub>i</sub> = 0');
    expect(APRENDER).toContain('residualizar');
    expect(APRENDER).toContain('es BLUE');
  });

  it('covers effective samples and cautions against comparing different listwise samples', () => {
    expect(APRENDER).toContain('eliminacion listwise');
    expect(APRENDER).toContain('misma muestra efectiva');
    expect(APRENDER).toContain('composicion de la muestra');
  });

  it('derives fit statistics and explains their limits', () => {
    expect(APRENDER).toContain('R<sup>2</sup> = 1 - SSR / SST');
    expect(APRENDER).toContain('R2 nunca baja al agregar una X');
    expect(APRENDER).toContain('regresion espuria');
    expect(APRENDER).toContain('SSR<sub>R</sub> - SSR<sub>UR</sub>');
  });

  it('states frequentist inference correctly and separates statistical from economic significance', () => {
    expect(APRENDER).toContain('suponiendo H0 y el modelo de contraste');
    expect(APRENDER).toContain('no se rechaza. Esto ultimo no demuestra que H0 sea verdadera');
    expect(APRENDER).toContain('La economica pregunta si su magnitud importa');
    expect(APRENDER).toContain('no es correcto decir que hay 95% de probabilidad');
    expect(APRENDER).not.toContain('rango probable del coeficiente');
  });

  it('adds one/two-sided tests, decision errors, power and a study procedure', () => {
    expect(APRENDER).toContain('Una o dos colas');
    expect(APRENDER).toContain('Error tipo I');
    expect(APRENDER).toContain('Error tipo II');
    expect(APRENDER).toContain('La potencia');
    expect(APRENDER).toContain('fija &alpha; antes de mirar');
  });

  it('explains dummies with base category and the dummy trap', () => {
    expect(APRENDER).toContain('trampa de dummies');
    expect(APRENDER).toContain('region_Norte');
    expect(APRENDER).toContain('region_Centro');
    expect(APRENDER).toContain('100&middot;[exp(&delta;)-1]');
    expect(APRENDER).toContain('D&middot;X');
  });

  it('connects assumptions to consequences and develops omitted-variable bias', () => {
    expect(APRENDER).toContain('Supuestos OLS y consecuencias');
    expect(APRENDER).toContain('Sesgo por variable omitida');
    expect(APRENDER).toContain('Causalidad simultanea');
    expect(APRENDER).toContain('menor varianza entre estimadores lineales insesgados');
  });

  it('explains robust errors (classic/HC1/HC3) without claiming they change the betas', () => {
    expect(APRENDER).toContain('HC1');
    expect(APRENDER).toContain('HC3');
    expect(APRENDER).toContain('No cambian los coeficientes OLS');
    expect(APRENDER).toContain('HAC/Newey-West');
  });

  it('explains Breusch-Pagan with H0 and the 5% reading', () => {
    expect(APRENDER).toContain('H0: homocedasticidad');
    expect(APRENDER).toContain('p &lt; 0.05');
    expect(APRENDER).toContain('no demuestra homocedasticidad');
  });

  it('explains ADF specification and finite-sample critical-value reading', () => {
    expect(APRENDER).toContain('H0: &gamma; = 0');
    expect(APRENDER).toContain('Constante, tendencia y cantidad de rezagos');
    expect(APRENDER).toContain('valores criticos MacKinnon ajustados por el n efectivo');
    expect(APRENDER).toContain('no confirma una raiz unitaria');
  });

  it('explains ARIMA p/d/q with the ARIMA(1,1,1) example and the honesty note', () => {
    expect(APRENDER).toContain('ARIMA(1,1,1)');
    expect(APRENDER).toContain('ARIMA no adivina el futuro');
    expect(APRENDER).toContain('Estabilidad e invertibilidad');
    expect(APRENDER).toContain('AIC y BIC comparan ajuste penalizando complejidad');
  });

  it('explains forecast with horizon, intervals and why they widen', () => {
    expect(APRENDER).toContain('pronostico puntual');
    expect(APRENDER).toContain('abrirse a medida que crece el horizonte');
    expect(APRENDER).toContain('no es una promesa');
    expect(APRENDER).toContain('conjunto de prueba');
    expect(APRENDER).toContain('MAE o RMSE');
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

  it('keeps every internal theory link resolvable to one unique concept id', () => {
    const links = [...GUIA_HTML.matchAll(/href="#(teoria-[^"]+)"/g)].map(match => match[1]);
    expect(links.length).toBeGreaterThan(10);

    for (const id of new Set(links)) {
      const targets = GUIA_HTML.match(new RegExp(`id="${id}"`, 'g')) ?? [];
      expect(targets, `broken or duplicate target #${id}`).toHaveLength(1);
    }
  });

  it('routes concept hashes into the Aprender panel and opens ancestor details', () => {
    expect(GUIA_HTML).toContain("target.closest('#area-aprender')");
    expect(GUIA_HTML).toContain("showDocumentationArea('aprender')");
    expect(GUIA_HTML).toContain("if (current.tagName === 'DETAILS') current.open = true");
    expect(GUIA_HTML).toContain("target.scrollIntoView({ block: 'start' })");
    expect(GUIA_HTML).toContain("window.addEventListener('hashchange', showHashTarget)");
  });
});
