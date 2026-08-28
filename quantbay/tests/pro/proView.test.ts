import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProResult,
  getSelectedProStandardErrorType,
  renderProResult,
  setProSeSelectorVisible,
  showProStatus,
  type ProComparison,
} from '../../src/ui/proView';
import type { PyodideOlsResult } from '../../src/pro/pyodide/proResultTypes';

function mountProPanel(): void {
  document.body.innerHTML = `
    <div id="qb-pro-se-wrap" style="display:none">
      <select id="qb-pro-se">
        <option value="classic" selected>Clásicos</option>
        <option value="HC1">Robustos HC1</option>
        <option value="HC3">Robustos HC3</option>
      </select>
    </div>
    <section id="qb-pro-results" style="display:none">
      <div id="qb-pro-status" style="display:none"></div>
      <div id="qb-pro-error" style="display:none"></div>
      <div id="qb-pro-content" style="display:none">
        <div id="qb-pro-categorical"></div>
        <table><tbody id="qb-pro-coef-body"></tbody></table>
        <table><tbody id="qb-pro-stats-body"></tbody></table>
        <div id="qb-pro-inference"></div>
        <div id="qb-pro-rls-test"></div>
        <div id="qb-pro-bp-test"></div>
        <div id="qb-pro-warnings"></div>
        <div id="qb-pro-comparison"></div>
      </div>
    </section>`;
}

const okResult: PyodideOlsResult = {
  ok: true,
  engine: 'pyodide',
  functionalForm: 'lin-lin',
  yName: 'y',
  xNames: ['x'],
  nobs: 5,
  coefficients: [
    { name: 'Intercept', estimate: 1.0, stdError: 0.1, tStat: 10.0, pValue: 0.002145 },
    { name: 'x', estimate: 2.0, stdError: 0.05, tStat: 40.0, pValue: 0.000034 },
  ],
  rSquared: 0.999,
  rSquaredAdj: 0.998,
  fStat: 1600.0,
  fPValue: 0.000034,
  dfResid: 3,
  residualStdError: 0.01,
  residuals: [0.01, -0.01, 0, 0.01, -0.01],
  fitted: [3, 5, 7, 9, 11],
  warnings: [],
};

beforeEach(() => {
  mountProPanel();
});

describe('renderProResult (statsmodels)', () => {
  it('renders coefficients with estimate, standard error, t and p-value', () => {
    renderProResult(okResult);

    const rows = Array.from(document.querySelectorAll('#qb-pro-coef-body tr'));
    expect(rows).toHaveLength(2);
    const cells = Array.from(rows[1].querySelectorAll('td')).map(td => td.textContent);
    expect(cells).toEqual(['x', '2.000000', '0.050000', '40.000000', '0.000034']);
    expect(document.getElementById('qb-pro-content')?.style.display).toBe('');
    expect(document.getElementById('qb-pro-error')?.style.display).toBe('none');
  });

  it('renders em dashes for null t/p (perfect fit) instead of NaN', () => {
    const perfectFit: PyodideOlsResult = {
      ...okResult,
      coefficients: [{ name: 'x', estimate: 2.0, stdError: 0.0, tStat: null, pValue: null }],
      fStat: undefined,
      fPValue: undefined,
    };
    renderProResult(perfectFit);

    const cells = Array.from(document.querySelectorAll('#qb-pro-coef-body td')).map(td => td.textContent);
    expect(cells).toEqual(['x', '2.000000', '0.000000', '—', '—']);
  });

  it('renders the model summary with R², adjusted R², F-stat, its p-value, n and dof', () => {
    renderProResult(okResult);

    const text = document.getElementById('qb-pro-stats-body')?.textContent ?? '';
    expect(text).toContain('Forma funcional');
    expect(text).toContain('Lin-Lin');
    expect(text).toContain('Observaciones (n)');
    expect(text).toContain('5');
    expect(text).toContain('R²');
    expect(text).toContain('0.999000');
    expect(text).toContain('R² ajustado');
    expect(text).toContain('0.998000');
    expect(text).toContain('F-stat');
    expect(text).toContain('1600.000000');
    expect(text).toContain('p-value (F)');
    expect(text).toContain('Grados de libertad (residual)');
    expect(text).toContain('statsmodels');
  });

  it('renders the Lite vs Pro comparison with coefficients, R² and n', () => {
    const comparison: ProComparison = {
      rows: [
        { name: 'Intercept', liteEstimate: 1.0, proEstimate: 1.0 },
        { name: 'x', liteEstimate: 2.0, proEstimate: 2.0 },
      ],
      liteRSquared: 0.999,
      liteNobs: 5,
    };
    renderProResult(okResult, comparison);

    const html = document.getElementById('qb-pro-comparison')?.innerHTML ?? '';
    expect(html).toContain('Comparación Lite vs Pro');
    expect(html).toContain('Lin-Lin');
    expect(html).toContain('Intercept');
    expect(html).toContain('Métrica');
    expect(html).toContain('R²');
    expect(html).toContain('Observaciones (n)');
  });

  it('labels the comparison with the functional form actually estimated, never a mismatched one', () => {
    const comparison: ProComparison = {
      rows: [
        { name: 'Intercept', liteEstimate: 1.0, proEstimate: 1.0 },
        { name: 'ln(x)', liteEstimate: 2.0, proEstimate: 2.0 },
      ],
      liteRSquared: 0.95,
      liteNobs: 5,
    };
    renderProResult({ ...okResult, functionalForm: 'log-log', yName: 'ln(y)', xNames: ['ln(x)'] }, comparison);

    const html = document.getElementById('qb-pro-comparison')?.innerHTML ?? '';
    expect(html).toContain('Log-Log');
    expect(html).not.toContain('Lin-Lin');
  });

  it('clears the comparison block when no comparison is available', () => {
    renderProResult(okResult, null);
    expect(document.getElementById('qb-pro-comparison')?.innerHTML).toBe('');
  });

  it('renders the RLS test section with H0, F-stat, p-value and the reject/no-reject verdict', () => {
    renderProResult({
      ...okResult,
      rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true },
    });

    const html = document.getElementById('qb-pro-rls-test')?.innerHTML ?? '';
    expect(html).toContain('beta1 = 0');
    expect(html).toContain('4.200000');
    expect(html).toContain('0.030000');
    expect(html).toContain('Se rechaza H0 al 5%');
  });

  it('shows "no se rechaza" when the restriction test does not reject at 5%', () => {
    renderProResult({
      ...okResult,
      rlsTest: { label: 'beta1 = 0', fStat: 0.1, fPValue: 0.9, dfNum: 1, dfDenom: 3, reject: false },
    });

    const html = document.getElementById('qb-pro-rls-test')?.innerHTML ?? '';
    expect(html).toContain('No se rechaza H0 al 5%');
  });

  it('clears the RLS test section when no restriction was evaluated', () => {
    renderProResult(okResult);
    expect(document.getElementById('qb-pro-rls-test')?.innerHTML).toBe('');
  });

  it('includes the Lite-vs-Pro restriction test comparison when provided', () => {
    const comparison: ProComparison = {
      rows: [],
      liteRSquared: null,
      liteNobs: null,
      rlsTest: { label: 'beta1 = 0', liteFStat: 4.19, litePValue: 0.031 },
    };
    renderProResult(
      { ...okResult, rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true } },
      comparison
    );

    const html = document.getElementById('qb-pro-rls-test')?.innerHTML ?? '';
    expect(html).toContain('4.190000');
    expect(html).toContain('4.200000');
  });

  it('never re-estimates coefficients under the restriction: the note says so explicitly', () => {
    renderProResult({
      ...okResult,
      rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true },
    });

    const html = document.getElementById('qb-pro-rls-test')?.innerHTML ?? '';
    expect(html).toContain('no re-estima los coeficientes');
  });

  it('RLS + classical: says the F should match Lite\'s classical F save for minor numerical differences', () => {
    renderProResult({
      ...okResult,
      standardErrorType: 'classic',
      rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true },
    });

    const html = document.getElementById('qb-pro-rls-test')?.innerHTML ?? '';
    expect(html).toContain('debería coincidir con el F clásico de Lite');
  });

  it('RLS + HC3: warns that the restriction test uses the robust covariance and may differ from Lite\'s classical F', () => {
    renderProResult({
      ...okResult,
      standardErrorType: 'HC3',
      rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true },
    });

    const html = document.getElementById('qb-pro-rls-test')?.innerHTML ?? '';
    expect(html).toContain('matriz de covarianza robusta seleccionada');
    expect(html).toContain('errores estándar robustos HC3');
    expect(html).toContain('puede diferir del F clásico de Lite');
  });

  it('RLS + HC1: same robust-covariance caveat, naming HC1', () => {
    renderProResult({
      ...okResult,
      standardErrorType: 'HC1',
      rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true },
    });

    const html = document.getElementById('qb-pro-rls-test')?.innerHTML ?? '';
    expect(html).toContain('errores estándar robustos HC1');
    expect(html).toContain('puede diferir del F clásico de Lite');
  });

  it('shows the error block and hides content on ok:false results', () => {
    renderProResult({ ok: false, engine: 'pyodide', warnings: [], error: 'Columna Y faltante.' });

    const error = document.getElementById('qb-pro-error');
    expect(error?.style.display).toBe('');
    expect(error?.textContent).toBe('Columna Y faltante.');
    expect(document.getElementById('qb-pro-content')?.style.display).toBe('none');
  });

  it('muestra inferencia clásica en el resumen cuando no hay tipo explícito (default)', () => {
    renderProResult(okResult);

    const text = document.getElementById('qb-pro-stats-body')?.textContent ?? '';
    expect(text).toContain('Inferencia');
    expect(text).toContain('errores estándar clásicos');
  });

  it('muestra inferencia clásica explícita en el resumen', () => {
    renderProResult({ ...okResult, standardErrorType: 'classic' });

    const text = document.getElementById('qb-pro-stats-body')?.textContent ?? '';
    expect(text).toContain('errores estándar clásicos');
  });

  it('muestra inferencia robusta HC1 en el resumen', () => {
    renderProResult({ ...okResult, standardErrorType: 'HC1' });

    const text = document.getElementById('qb-pro-stats-body')?.textContent ?? '';
    expect(text).toContain('errores estándar robustos HC1');
  });

  it('muestra inferencia robusta HC3 en el resumen', () => {
    renderProResult({ ...okResult, standardErrorType: 'HC3' });

    const text = document.getElementById('qb-pro-stats-body')?.textContent ?? '';
    expect(text).toContain('errores estándar robustos HC3');
  });

  describe('sección dedicada de inferencia (qb-pro-inference)', () => {
    it('classical: explica que t-stats, p-values, intervalos y tests asumen homocedasticidad', () => {
      renderProResult({ ...okResult, standardErrorType: 'classic' });

      const html = document.getElementById('qb-pro-inference')?.innerHTML ?? '';
      expect(html).toContain('Inferencia: errores estándar clásicos');
      expect(html).toContain('homocedasticidad');
    });

    it('HC3: explica que t-stats, p-values, intervalos y tests usan la covarianza HC3', () => {
      renderProResult({ ...okResult, standardErrorType: 'HC3' });

      const html = document.getElementById('qb-pro-inference')?.innerHTML ?? '';
      expect(html).toContain('Inferencia: errores estándar robustos HC3');
      expect(html).toContain('HC3');
    });

    it('HC1: explica que t-stats, p-values, intervalos y tests usan la covarianza HC1', () => {
      renderProResult({ ...okResult, standardErrorType: 'HC1' });

      const html = document.getElementById('qb-pro-inference')?.innerHTML ?? '';
      expect(html).toContain('Inferencia: errores estándar robustos HC1');
      expect(html).toContain('HC1');
    });

    it('se renderiza incluso sin standardErrorType explícito (default classic)', () => {
      renderProResult(okResult);

      const html = document.getElementById('qb-pro-inference')?.innerHTML ?? '';
      expect(html).toContain('errores estándar clásicos');
    });
  });

  describe('Test Breusch-Pagan (qb-pro-bp-test)', () => {
    const bpReject = {
      lmStatistic: 8.2,
      lmPValue: 0.017,
      fStatistic: 9.4,
      fPValue: 0.032,
      rejectAt5: true,
      interpretation: 'Se rechaza homocedasticidad al 5% (evidencia de heterocedasticidad).',
    };
    const bpNoReject = {
      lmStatistic: 0.6,
      lmPValue: 0.74,
      fStatistic: 0.5,
      fPValue: 0.71,
      rejectAt5: false,
      interpretation: 'No se rechaza homocedasticidad al 5% (sin evidencia suficiente de heterocedasticidad).',
    };

    it('muestra H0, LM y F statistics, p-values y la conclusión', () => {
      renderProResult({ ...okResult, breuschPagan: bpReject });

      const html = document.getElementById('qb-pro-bp-test')?.innerHTML ?? '';
      expect(html).toContain('varianza constante de los errores');
      expect(html).toContain('8.200000');
      expect(html).toContain('0.017000');
      expect(html).toContain('9.400000');
      expect(html).toContain('0.032000');
      expect(html).toContain('Se rechaza homocedasticidad al 5%');
    });

    it('muestra la conclusión de no-rechazo cuando el p-value (F) es >= 0.05', () => {
      renderProResult({ ...okResult, breuschPagan: bpNoReject });

      const html = document.getElementById('qb-pro-bp-test')?.innerHTML ?? '';
      expect(html).toContain('No se rechaza homocedasticidad al 5%');
    });

    it('clears the Breusch-Pagan section when it was not computed for this run', () => {
      renderProResult(okResult);
      expect(document.getElementById('qb-pro-bp-test')?.innerHTML).toBe('');
    });

    it('classical + BP rechaza: sugiere probar HC3', () => {
      renderProResult({ ...okResult, standardErrorType: 'classic', breuschPagan: bpReject });

      const html = document.getElementById('qb-pro-bp-test')?.innerHTML ?? '';
      expect(html).toContain('Breusch-Pagan sugiere heterocedasticidad');
      expect(html).toContain('Probá HC3');
    });

    it('classical + BP no rechaza: no sugiere HC3', () => {
      renderProResult({ ...okResult, standardErrorType: 'classic', breuschPagan: bpNoReject });

      const html = document.getElementById('qb-pro-bp-test')?.innerHTML ?? '';
      expect(html).not.toContain('Probá HC3');
    });

    it('HC3 + BP rechaza: no repite la sugerencia (ya está en HC3)', () => {
      renderProResult({ ...okResult, standardErrorType: 'HC3', breuschPagan: bpReject });

      const html = document.getElementById('qb-pro-bp-test')?.innerHTML ?? '';
      expect(html).not.toContain('Probá HC3');
    });
  });

  describe('sección de variables categóricas (qb-pro-categorical)', () => {
    const categoricalInfo = [
      { originalName: 'region', baseCategory: 'Centro', createdDummies: ['region_Norte', 'region_Sur'], categories: ['Centro', 'Norte', 'Sur'] },
    ];

    it('muestra el nombre de la variable, la categoría base y las dummies creadas', () => {
      renderProResult({ ...okResult, categoricalInfo });

      const html = document.getElementById('qb-pro-categorical')?.innerHTML ?? '';
      expect(html).toContain('Variables categóricas');
      expect(html).toContain('region');
      expect(html).toContain('Centro');
      expect(html).toContain('region_Norte');
      expect(html).toContain('region_Sur');
    });

    it('incluye la nota pedagógica sobre la categoría base y la trampa de dummies', () => {
      renderProResult({ ...okResult, categoricalInfo });

      const html = document.getElementById('qb-pro-categorical')?.innerHTML ?? '';
      expect(html).toContain('trampa de dummies');
      expect(html).toContain('categoría base');
    });

    it('renders one block per categorical variable when there is more than one', () => {
      renderProResult({
        ...okResult,
        categoricalInfo: [
          ...categoricalInfo,
          { originalName: 'sector', baseCategory: 'Comercio', createdDummies: ['sector_Finanzas'], categories: ['Comercio', 'Finanzas'] },
        ],
      });

      const html = document.getElementById('qb-pro-categorical')?.innerHTML ?? '';
      expect(html).toContain('region');
      expect(html).toContain('sector');
      expect(html).toContain('sector_Finanzas');
    });

    it('clears the categorical section when there is no categorical info for this run', () => {
      renderProResult(okResult);
      expect(document.getElementById('qb-pro-categorical')?.innerHTML).toBe('');
    });

    it('clears the categorical section when categoricalInfo is an empty array', () => {
      renderProResult({ ...okResult, categoricalInfo: [] });
      expect(document.getElementById('qb-pro-categorical')?.innerHTML).toBe('');
    });

    it('escapes HTML in categorical variable/category/dummy names', () => {
      renderProResult({
        ...okResult,
        categoricalInfo: [
          { originalName: '<img src=x>', baseCategory: 'A', createdDummies: ['<script>alert(1)</script>'], categories: ['A', 'B'] },
        ],
      });

      expect(document.querySelector('#qb-pro-categorical img')).toBeNull();
      expect(document.querySelector('#qb-pro-categorical script')).toBeNull();
    });

    it('clearProResult empties the categorical section', () => {
      renderProResult({ ...okResult, categoricalInfo });
      expect(document.getElementById('qb-pro-categorical')?.innerHTML).not.toBe('');

      clearProResult();

      expect(document.getElementById('qb-pro-categorical')?.innerHTML).toBe('');
    });
  });

  describe('comparación Lite vs Pro omitida por diseño distinto (designMismatch)', () => {
    it('muestra el mensaje explícito y no la tabla de coeficientes ni de métricas', () => {
      const comparison: ProComparison = {
        rows: [],
        liteRSquared: null,
        liteNobs: null,
        designMismatch: 'La comparación Lite vs Pro se omitió porque los motores no construyeron la misma matriz de diseño.',
      };
      renderProResult(okResult, comparison);

      const html = document.getElementById('qb-pro-comparison')?.innerHTML ?? '';
      expect(html).toContain('se omitió porque los motores no construyeron la misma matriz de diseño');
      expect(html).not.toContain('<table');
    });
  });

  it('la comparación Lite vs Pro sigue renderizando con Pro robusto y aclara los errores estándar', () => {
    const comparison: ProComparison = {
      rows: [{ name: 'x', liteEstimate: 2.0, proEstimate: 2.0 }],
      liteRSquared: 0.999,
      liteNobs: 5,
    };
    renderProResult({ ...okResult, standardErrorType: 'HC3' }, comparison);

    const html = document.getElementById('qb-pro-comparison')?.innerHTML ?? '';
    expect(html).toContain('Comparación Lite vs Pro');
    expect(html).toContain('Lite usa errores estándar clásicos');
    expect(html).toContain('errores estándar robustos HC3');
  });

  it('la comparación con Pro clásico no agrega la aclaración de robustos', () => {
    const comparison: ProComparison = {
      rows: [{ name: 'x', liteEstimate: 2.0, proEstimate: 2.0 }],
      liteRSquared: 0.999,
      liteNobs: 5,
    };
    renderProResult({ ...okResult, standardErrorType: 'classic' }, comparison);

    const html = document.getElementById('qb-pro-comparison')?.innerHTML ?? '';
    expect(html).toContain('Comparación Lite vs Pro');
    expect(html).not.toContain('Lite usa errores estándar clásicos y Pro está usando');
  });

  it('escapes HTML in variable names and warnings', () => {
    renderProResult({
      ...okResult,
      coefficients: [{ name: '<img src=x>', estimate: 1.0, stdError: null, tStat: null, pValue: null }],
      warnings: ['<script>alert(1)</script>'],
    });

    expect(document.querySelector('#qb-pro-coef-body img')).toBeNull();
    expect(document.querySelector('#qb-pro-warnings script')).toBeNull();
  });
});

describe('selector de errores estándar Pro', () => {
  it('setProSeSelectorVisible muestra el selector cuando el motor Pro está activo', () => {
    setProSeSelectorVisible(true);
    expect(document.getElementById('qb-pro-se-wrap')?.style.display).toBe('');
  });

  it('setProSeSelectorVisible oculta el selector fuera del motor Pro', () => {
    setProSeSelectorVisible(true);
    setProSeSelectorVisible(false);
    expect(document.getElementById('qb-pro-se-wrap')?.style.display).toBe('none');
  });

  it('getSelectedProStandardErrorType devuelve el valor elegido en el selector', () => {
    const select = document.getElementById('qb-pro-se') as HTMLSelectElement;
    select.value = 'HC3';
    expect(getSelectedProStandardErrorType()).toBe('HC3');
    select.value = 'HC1';
    expect(getSelectedProStandardErrorType()).toBe('HC1');
  });

  it('el default del selector es classic', () => {
    expect(getSelectedProStandardErrorType()).toBe('classic');
  });

  it('sin selector montado (flujo Lite) devuelve classic y no rompe', () => {
    document.body.innerHTML = '';
    expect(getSelectedProStandardErrorType()).toBe('classic');
  });
});

describe('re-run del panel Pro no deja resultados viejos visibles', () => {
  beforeEach(() => {
    mountProPanel();
  });

  it('clearProResult oculta el contenido anterior y vacía coeficientes, resumen, advertencias y comparación', () => {
    const comparison: ProComparison = {
      rows: [{ name: 'x', liteEstimate: 2.0, proEstimate: 2.0 }],
      liteRSquared: 0.999,
      liteNobs: 5,
    };
    renderProResult(okResult, comparison);
    expect(document.getElementById('qb-pro-content')?.style.display).toBe('');
    expect(document.getElementById('qb-pro-coef-body')?.innerHTML).not.toBe('');

    clearProResult();

    expect(document.getElementById('qb-pro-content')?.style.display).toBe('none');
    expect(document.getElementById('qb-pro-coef-body')?.innerHTML).toBe('');
    expect(document.getElementById('qb-pro-stats-body')?.innerHTML).toBe('');
    expect(document.getElementById('qb-pro-warnings')?.innerHTML).toBe('');
    expect(document.getElementById('qb-pro-comparison')?.innerHTML).toBe('');
  });

  it('clearProResult también vacía la sección de inferencia, el test RLS y el test Breusch-Pagan', () => {
    renderProResult({
      ...okResult,
      standardErrorType: 'HC3',
      rlsTest: { label: 'beta1 = 0', fStat: 4.2, fPValue: 0.03, dfNum: 1, dfDenom: 3, reject: true },
      breuschPagan: {
        lmStatistic: 8.2,
        lmPValue: 0.017,
        fStatistic: 9.4,
        fPValue: 0.032,
        rejectAt5: true,
        interpretation: 'Se rechaza homocedasticidad al 5% (evidencia de heterocedasticidad).',
      },
    });
    expect(document.getElementById('qb-pro-inference')?.innerHTML).not.toBe('');
    expect(document.getElementById('qb-pro-rls-test')?.innerHTML).not.toBe('');
    expect(document.getElementById('qb-pro-bp-test')?.innerHTML).not.toBe('');

    clearProResult();

    expect(document.getElementById('qb-pro-inference')?.innerHTML).toBe('');
    expect(document.getElementById('qb-pro-rls-test')?.innerHTML).toBe('');
    expect(document.getElementById('qb-pro-bp-test')?.innerHTML).toBe('');
  });

  it('clearProResult también oculta un error previo', () => {
    renderProResult({ ok: false, engine: 'pyodide', warnings: [], error: 'Columna Y faltante.' });
    expect(document.getElementById('qb-pro-error')?.style.display).toBe('');

    clearProResult();

    const error = document.getElementById('qb-pro-error');
    expect(error?.style.display).toBe('none');
    expect(error?.textContent).toBe('');
  });

  it('el estado de carga se puede mostrar justo después de limpiar el resultado previo', () => {
    renderProResult(okResult);
    clearProResult();
    showProStatus('Cargando Python en navegador…');

    const status = document.getElementById('qb-pro-status');
    expect(status?.textContent).toBe('Cargando Python en navegador…');
    expect(status?.style.display).toBe('');
    // Ni coeficientes ni resumen del cálculo anterior deben seguir visibles
    // mientras se muestra el estado de carga del nuevo cálculo.
    expect(document.getElementById('qb-pro-content')?.style.display).toBe('none');
  });

  it('el resultado nuevo se renderiza normalmente después de limpiar uno anterior', () => {
    renderProResult({ ...okResult, coefficients: [{ name: 'x', estimate: 99.0, stdError: 1.0, tStat: 99.0, pValue: 0.01 }] });
    clearProResult();

    renderProResult(okResult);

    const cells = Array.from(document.querySelectorAll('#qb-pro-coef-body td')).map(td => td.textContent);
    // El coeficiente viejo (99.0) no debe aparecer; solo los del resultado nuevo.
    expect(cells).not.toContain('99.000000');
    expect(cells).toContain('2.000000');
    expect(document.getElementById('qb-pro-content')?.style.display).toBe('');
  });
});
