import { beforeEach, describe, expect, it } from 'vitest';
import { renderProResult, type ProComparison } from '../../src/ui/proView';
import type { PyodideOlsResult } from '../../src/pro/pyodide/proResultTypes';

function mountProPanel(): void {
  document.body.innerHTML = `
    <section id="qb-pro-results" style="display:none">
      <div id="qb-pro-status" style="display:none"></div>
      <div id="qb-pro-error" style="display:none"></div>
      <div id="qb-pro-content" style="display:none">
        <table><tbody id="qb-pro-coef-body"></tbody></table>
        <table><tbody id="qb-pro-stats-body"></tbody></table>
        <div id="qb-pro-warnings"></div>
        <div id="qb-pro-comparison"></div>
      </div>
    </section>`;
}

const okResult: PyodideOlsResult = {
  ok: true,
  engine: 'pyodide',
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
    expect(html).toContain('Intercept');
    expect(html).toContain('Métrica');
    expect(html).toContain('R²');
    expect(html).toContain('Observaciones (n)');
  });

  it('clears the comparison block when no comparison is available', () => {
    renderProResult(okResult, null);
    expect(document.getElementById('qb-pro-comparison')?.innerHTML).toBe('');
  });

  it('shows the error block and hides content on ok:false results', () => {
    renderProResult({ ok: false, engine: 'pyodide', warnings: [], error: 'Columna Y faltante.' });

    const error = document.getElementById('qb-pro-error');
    expect(error?.style.display).toBe('');
    expect(error?.textContent).toBe('Columna Y faltante.');
    expect(document.getElementById('qb-pro-content')?.style.display).toBe('none');
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
