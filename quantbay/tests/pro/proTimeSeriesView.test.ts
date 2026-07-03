import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearProTimeSeriesResult,
  getProTimeSeriesAdfRegression,
  getProTimeSeriesMaxLag,
  getSelectedProTimeSeriesValueColumn,
  renderProTimeSeriesResult,
  renderProTimeSeriesSelectors,
} from '../../src/ui/proTimeSeriesView';
import type { PyodideTimeSeriesResult } from '../../src/pro/pyodide/proTimeSeriesResultTypes';
import type { ParsedCSV } from '../../src/csvParser';

function mountPanel(): void {
  document.body.innerHTML = `
    <section id="qb-pro-ts-panel" style="display:none">
      <div id="qb-pro-ts-empty"></div>
      <div id="qb-pro-ts-controls" style="display:none">
        <select id="qb-pro-ts-value"></select>
        <input id="qb-pro-ts-maxlag" type="number" value="12">
        <select id="qb-pro-ts-adf-reg">
          <option value="c" selected>c</option>
          <option value="ct">ct</option>
          <option value="ctt">ctt</option>
          <option value="n">n</option>
        </select>
        <button id="qb-pro-ts-run"></button>
      </div>
      <div id="qb-pro-ts-status" style="display:none"></div>
      <div id="qb-pro-ts-error" style="display:none"></div>
      <div id="qb-pro-ts-content" style="display:none">
        <div id="qb-pro-ts-adf"></div>
        <div id="qb-pro-ts-acfpacf"></div>
        <div id="qb-pro-ts-ljungbox"></div>
        <div id="qb-pro-ts-note"></div>
        <div id="qb-pro-ts-arima-note"></div>
        <div id="qb-pro-ts-warnings"></div>
      </div>
    </section>`;
}

const okResult: PyodideTimeSeriesResult = {
  ok: true,
  engine: 'pyodide',
  variableName: 'serie',
  observations: 40,
  adfRegression: 'c',
  maxLag: 3,
  adf: {
    statistic: -3.512345,
    pValue: 0.008123,
    usedLag: 1,
    nobs: 38,
    criticalValues: { '1%': -3.6, '5%': -2.9, '10%': -2.6 },
    icBest: 12.3,
    rejectAt5: true,
    interpretation: 'Se rechaza H0 al 5%: hay evidencia de estacionariedad (la serie no tendría raíz unitaria).',
  },
  acf: [
    { lag: 1, value: 0.5 },
    { lag: 2, value: 0.25 },
    { lag: 3, value: 0.1 },
  ],
  pacf: [
    { lag: 1, value: 0.5 },
    { lag: 2, value: -0.1 },
    { lag: 3, value: 0.02 },
  ],
  ljungBox: [
    { lag: 1, statistic: 5.2, pValue: 0.02, rejectAt5: true, interpretation: '' },
    { lag: 2, statistic: 6.5, pValue: 0.09, rejectAt5: false, interpretation: '' },
  ],
  warnings: [],
};

beforeEach(() => {
  mountPanel();
});

describe('renderProTimeSeriesResult', () => {
  it('renders the ADF block with H0, statistic, p-value and conclusion', () => {
    renderProTimeSeriesResult(okResult);

    const html = document.getElementById('qb-pro-ts-adf')?.innerHTML ?? '';
    expect(html).toContain('H0');
    expect(html).toContain('raíz unitaria');
    expect(html).toContain('-3.512345');
    expect(html).toContain('0.008123');
    expect(html).toContain('Se rechaza H0 al 5%');
    expect(document.getElementById('qb-pro-ts-content')?.style.display).toBe('');
  });

  it('shows the ADF critical values', () => {
    renderProTimeSeriesResult(okResult);
    const html = document.getElementById('qb-pro-ts-adf')?.innerHTML ?? '';
    expect(html).toContain('1%');
    expect(html).toContain('5%');
    expect(html).toContain('-2.900000');
  });

  it('renders a Lag / ACF / PACF table', () => {
    renderProTimeSeriesResult(okResult);
    const el = document.getElementById('qb-pro-ts-acfpacf');
    const text = el?.textContent ?? '';
    expect(text).toContain('Lag');
    expect(text).toContain('ACF');
    expect(text).toContain('PACF');
    // 3 lags → 3 body rows.
    expect(el?.querySelectorAll('tbody tr')).toHaveLength(3);
  });

  it('renders a Ljung-Box table with lag, Q-stat, p-value and conclusion', () => {
    renderProTimeSeriesResult(okResult);
    const el = document.getElementById('qb-pro-ts-ljungbox');
    const text = el?.textContent ?? '';
    expect(text).toContain('Q-stat');
    expect(text).toContain('p-value');
    expect(text).toContain('Se rechaza H0 al 5%');
    expect(text).toContain('No se rechaza H0 al 5%');
    expect(el?.querySelectorAll('tbody tr')).toHaveLength(2);
  });

  it('shows the pedagogical note about ADF, ACF/PACF and Ljung-Box', () => {
    renderProTimeSeriesResult(okResult);
    const text = document.getElementById('qb-pro-ts-note')?.textContent ?? '';
    expect(text).toContain('ADF evalúa estacionariedad');
    expect(text).toContain('ACF/PACF');
    expect(text).toContain('Ljung-Box');
  });

  it('communicates honestly that ARIMA is not implemented yet', () => {
    renderProTimeSeriesResult(okResult);
    const text = document.getElementById('qb-pro-ts-arima-note')?.textContent ?? '';
    expect(text).toContain('ARIMA todavía no está implementado');
  });

  it('renders warnings when present', () => {
    renderProTimeSeriesResult({ ...okResult, warnings: ['Se descartaron 2 observaciones no numéricas.'] });
    const html = document.getElementById('qb-pro-ts-warnings')?.innerHTML ?? '';
    expect(html).toContain('Se descartaron 2 observaciones');
  });

  it('shows the error block and hides content on an ok:false result', () => {
    renderProTimeSeriesResult({ ok: false, engine: 'pyodide', warnings: [], error: 'La serie es constante.' });
    const error = document.getElementById('qb-pro-ts-error');
    expect(error?.style.display).toBe('');
    expect(error?.textContent).toBe('La serie es constante.');
    expect(document.getElementById('qb-pro-ts-content')?.style.display).toBe('none');
  });

  it('handles a result where a diagnostic could not be computed (undefined)', () => {
    renderProTimeSeriesResult({ ...okResult, pacf: undefined, ljungBox: undefined });
    // ACF still present, PACF column falls back to em dashes, Ljung-Box shows unavailable.
    const acfPacf = document.getElementById('qb-pro-ts-acfpacf')?.textContent ?? '';
    expect(acfPacf).toContain('Lag');
    const lb = document.getElementById('qb-pro-ts-ljungbox')?.textContent ?? '';
    expect(lb).toContain('no disponible');
  });

  it('escapes HTML in warnings and variable-derived content', () => {
    renderProTimeSeriesResult({ ...okResult, warnings: ['<script>alert(1)</script>'] });
    expect(document.querySelector('#qb-pro-ts-warnings script')).toBeNull();
  });
});

describe('Pro TS selectors and getters', () => {
  const csv: ParsedCSV = {
    headers: ['fecha', 'pib', 'texto'],
    rows: [
      { fecha: '2020-01', pib: 100, texto: 'a' },
      { fecha: '2020-02', pib: 101, texto: 'b' },
    ],
    numericColumns: ['pib'],
  };

  it('populates the value selector with numeric columns and shows controls', () => {
    renderProTimeSeriesSelectors(csv);
    const select = document.getElementById('qb-pro-ts-value') as HTMLSelectElement;
    const options = Array.from(select.options).map(o => o.value);
    expect(options).toContain('pib');
    expect(options).not.toContain('texto');
    expect(document.getElementById('qb-pro-ts-controls')?.style.display).toBe('');
  });

  it('getSelectedProTimeSeriesValueColumn reads the selected series column', () => {
    renderProTimeSeriesSelectors(csv);
    expect(getSelectedProTimeSeriesValueColumn()).toBe('pib');
  });

  it('getProTimeSeriesMaxLag reads the max-lag input, defaulting when empty', () => {
    renderProTimeSeriesSelectors(csv);
    const input = document.getElementById('qb-pro-ts-maxlag') as HTMLInputElement;
    input.value = '8';
    expect(getProTimeSeriesMaxLag()).toBe(8);
    input.value = '';
    expect(getProTimeSeriesMaxLag()).toBe(12);
  });

  it('getProTimeSeriesAdfRegression reads the ADF regression select', () => {
    renderProTimeSeriesSelectors(csv);
    const select = document.getElementById('qb-pro-ts-adf-reg') as HTMLSelectElement;
    select.value = 'ct';
    expect(getProTimeSeriesAdfRegression()).toBe('ct');
  });

  it('falls back to "no data" when there is no numeric column', () => {
    renderProTimeSeriesSelectors({ headers: ['a'], rows: [{ a: 'x' }], numericColumns: [] });
    expect(document.getElementById('qb-pro-ts-empty')?.style.display).toBe('');
    expect(document.getElementById('qb-pro-ts-controls')?.style.display).toBe('none');
  });

  it('clearProTimeSeriesResult empties tables and hides content', () => {
    renderProTimeSeriesResult(okResult);
    expect(document.getElementById('qb-pro-ts-adf')?.innerHTML).not.toBe('');

    clearProTimeSeriesResult();

    expect(document.getElementById('qb-pro-ts-content')?.style.display).toBe('none');
    expect(document.getElementById('qb-pro-ts-adf')?.innerHTML).toBe('');
    expect(document.getElementById('qb-pro-ts-acfpacf')?.innerHTML).toBe('');
    expect(document.getElementById('qb-pro-ts-ljungbox')?.innerHTML).toBe('');
  });
});
