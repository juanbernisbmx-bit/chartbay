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
        <table><tbody id="qb-pro-coef-body"></tbody></table>
        <table><tbody id="qb-pro-stats-body"></tbody></table>
        <div id="qb-pro-rls-test"></div>
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

  it('setProSeSelectorVisible oculta el selector para Lite / Mega Pro', () => {
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
