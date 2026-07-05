import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearProTimeSeriesResult,
  destroyProForecastChart,
  getProArimaEnabled,
  getProArimaOrder,
  getProForecastSteps,
  getProTimeSeriesAdfRegression,
  getProTimeSeriesMaxLag,
  getSelectedProTimeSeriesDateColumn,
  getSelectedProTimeSeriesValueColumn,
  renderProTimeSeriesResult,
  renderProTimeSeriesSelectors,
} from '../../src/ui/proTimeSeriesView';
import type { ProArimaResult, PyodideTimeSeriesResult } from '../../src/pro/pyodide/proTimeSeriesResultTypes';
import type { ParsedCSV } from '../../src/csvParser';

function mountPanel(): void {
  document.body.innerHTML = `
    <section id="qb-pro-ts-panel" style="display:none">
      <div id="qb-pro-ts-empty"></div>
      <div id="qb-pro-ts-controls" style="display:none">
        <select id="qb-pro-ts-value"></select>
        <select id="qb-pro-ts-date"></select>
        <input id="qb-pro-ts-maxlag" type="number" value="12">
        <select id="qb-pro-ts-adf-reg">
          <option value="c" selected>c</option>
          <option value="ct">ct</option>
          <option value="ctt">ctt</option>
          <option value="n">n</option>
        </select>
        <input type="checkbox" id="qb-pro-ts-arima-enable">
        <input id="qb-pro-ts-arima-p" type="number" value="1">
        <input id="qb-pro-ts-arima-d" type="number" value="0">
        <input id="qb-pro-ts-arima-q" type="number" value="1">
        <input id="qb-pro-ts-forecast-steps" type="number" value="12">
        <button id="qb-pro-ts-run"></button>
      </div>
      <div id="qb-pro-ts-status" style="display:none"></div>
      <div id="qb-pro-ts-error" style="display:none"></div>
      <div id="qb-pro-ts-content" style="display:none">
        <div id="qb-pro-ts-time-index"></div>
        <div id="qb-pro-ts-adf"></div>
        <div id="qb-pro-ts-acfpacf"></div>
        <div id="qb-pro-ts-ljungbox"></div>
        <div id="qb-pro-ts-arima-section"></div>
        <div id="qb-pro-ts-forecast-chart-section" style="display:none">
          <canvas id="qb-pro-arima-forecast-chart"></canvas>
          <p id="qb-pro-ts-forecast-chart-note"></p>
          <div id="qb-pro-ts-forecast-chart-status"></div>
        </div>
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

  it('communicates honestly that ARIMA manual + basic forecast exist but auto-ARIMA does not', () => {
    renderProTimeSeriesResult(okResult);
    const text = document.getElementById('qb-pro-ts-arima-note')?.textContent ?? '';
    expect(text).toContain('forecast básico');
    expect(text).toContain('auto-ARIMA');
    expect(text).toContain('todavía no está implementada');
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

describe('renderProTimeSeriesResult · ARIMA', () => {
  const arima: ProArimaResult = {
    order: { p: 1, d: 1, q: 1 },
    converged: true,
    nobs: 39,
    logLikelihood: -55.234567,
    aic: 118.469134,
    bic: 126.112233,
    hqic: 121.223344,
    coefficients: [
      { name: 'ar.L1', estimate: 0.612345, standardError: 0.12, zStatistic: 5.1, pValue: 0.0001 },
      { name: 'ma.L1', estimate: -0.312345, standardError: 0.15, zStatistic: -2.08, pValue: 0.037 },
      { name: 'sigma2', estimate: 1.2, standardError: 0.2, zStatistic: 6.0, pValue: 0.0 },
    ],
    warnings: ['Maximum Likelihood optimization failed to converge.'],
    interpretation: 'ARIMA(1,1,1) combina términos autorregresivos AR(1), diferenciación d=1 y media móvil MA(1).',
  };
  const arimaResult: PyodideTimeSeriesResult = {
    ...okResult,
    arima,
    arimaResidualDiagnostics: {
      ljungBox: [{ lag: 1, statistic: 0.5, pValue: 0.48, rejectAt5: false, interpretation: '' }],
      interpretation: 'Si Ljung-Box no rechaza autocorrelación en los residuos, el modelo capturó razonablemente la dependencia temporal.',
    },
  };

  it('shows the estimated ARIMA(p,d,q) model label', () => {
    renderProTimeSeriesResult(arimaResult);
    const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
    expect(text).toContain('ARIMA(1,1,1)');
    expect(text).toContain('Modelo estimado');
    expect(text).toContain('Convergencia');
  });

  it('shows AIC, BIC, HQIC and log-likelihood', () => {
    renderProTimeSeriesResult(arimaResult);
    const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
    expect(text).toContain('AIC');
    expect(text).toContain('118.469134');
    expect(text).toContain('BIC');
    expect(text).toContain('126.112233');
    expect(text).toContain('HQIC');
    expect(text).toContain('Log-likelihood');
  });

  it('renders the coefficients table with parameter names, z-stat and p-value', () => {
    renderProTimeSeriesResult(arimaResult);
    const section = document.getElementById('qb-pro-ts-arima-section');
    const text = section?.textContent ?? '';
    expect(text).toContain('Parámetro');
    expect(text).toContain('ar.L1');
    expect(text).toContain('ma.L1');
    expect(text).toContain('sigma2');
    expect(text).toContain('z-stat');
    // 3 coefficient rows.
    const tables = section?.querySelectorAll('table');
    expect((tables?.length ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('shows the model warnings captured from statsmodels', () => {
    renderProTimeSeriesResult(arimaResult);
    const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
    expect(text).toContain('Advertencias del modelo');
    expect(text).toContain('failed to converge');
  });

  it('shows the AIC/BIC comparison note', () => {
    renderProTimeSeriesResult(arimaResult);
    const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
    expect(text).toContain('AIC y BIC sirven para comparar');
  });

  it('shows the residual Ljung-Box diagnostics', () => {
    renderProTimeSeriesResult(arimaResult);
    const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
    expect(text).toContain('Diagnóstico de residuos');
    expect(text).toContain('capturó razonablemente');
  });

  it('shows a controlled error in the ARIMA section while keeping the diagnostics', () => {
    renderProTimeSeriesResult({ ...okResult, arimaError: 'No se pudo estimar ARIMA con este orden.' });
    const section = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
    expect(section).toContain('No se pudo estimar ARIMA');
    // Diagnostics are untouched: ADF/ACF/Ljung-Box still rendered.
    expect(document.getElementById('qb-pro-ts-adf')?.innerHTML).not.toBe('');
    expect(document.getElementById('qb-pro-ts-ljungbox')?.innerHTML).not.toBe('');
    expect(document.getElementById('qb-pro-ts-content')?.style.display).toBe('');
  });

  it('leaves the ARIMA section empty when ARIMA was not requested', () => {
    renderProTimeSeriesResult(okResult);
    expect(document.getElementById('qb-pro-ts-arima-section')?.innerHTML).toBe('');
  });

  it('escapes HTML in ARIMA coefficient names and warnings', () => {
    renderProTimeSeriesResult({
      ...arimaResult,
      arima: {
        ...arima,
        coefficients: [{ name: '<img src=x>', estimate: 1, standardError: null, zStatistic: null, pValue: null }],
        warnings: ['<script>alert(1)</script>'],
      },
    });
    expect(document.querySelector('#qb-pro-ts-arima-section img')).toBeNull();
    expect(document.querySelector('#qb-pro-ts-arima-section script')).toBeNull();
  });

  it('shows "No informada" when convergence is unknown (undefined)', () => {
    renderProTimeSeriesResult({ ...arimaResult, arima: { ...arima, converged: undefined } });
    const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
    expect(text).toContain('No informada');
  });

  describe('forecast', () => {
    const forecastArima: PyodideTimeSeriesResult = {
      ...arimaResult,
      timeIndex: {
        columnName: 'fecha',
        labels: ['2024-01', '2024-02', '2024-03'],
        futureLabels: ['2024-04', '2024-05', '2024-06'],
        frequency: 'monthly',
        warnings: [],
      },
      arima: {
        ...arima,
        forecast: {
          steps: 3,
          confidenceLevel: 0.95,
          items: [
            { step: 1, period: '2024-04', mean: 10.512345, meanStandardError: 0.8, lower: 8.912345, upper: 12.112345 },
            { step: 2, period: '2024-05', mean: 10.7, meanStandardError: 1.1, lower: 8.5, upper: 12.9 },
            { step: 3, period: '2024-06', mean: 10.8, meanStandardError: null, lower: null, upper: null },
          ],
          warnings: [],
        },
      },
    };

    it('shows the forecast table with Período / Paso / Pronóstico / Límite inferior / Límite superior when dates exist', () => {
      renderProTimeSeriesResult(forecastArima);
      const section = document.getElementById('qb-pro-ts-arima-section');
      const text = section?.textContent ?? '';
      expect(text).toContain('Forecast ARIMA');
      expect(text).toContain('Período');
      expect(text).toContain('Paso');
      expect(text).toContain('Pronóstico');
      expect(text).toContain('Límite inferior');
      expect(text).toContain('Límite superior');
      expect(text).toContain('2024-04');
      expect(text).toContain('t+1');
      expect(text).toContain('10.512345');
      expect(text).toContain('8.912345');
      expect(text).toContain('12.112345');
      expect(text).toContain('95%');
    });

    it('renders null bounds as em dashes (intervals are never invented)', () => {
      renderProTimeSeriesResult(forecastArima);
      const rows = Array.from(document.querySelectorAll('#qb-pro-ts-arima-section table tr'))
        .map(tr => tr.textContent ?? '');
      const lastRow = rows.find(r => r.includes('2024-06')) ?? '';
      expect(lastRow).toContain('—');
    });

    it('shows the pedagogical forecast note', () => {
      renderProTimeSeriesResult(forecastArima);
      const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
      expect(text).toContain('proyecta valores futuros');
      expect(text).toContain('suelen ampliarse a medida que crece el horizonte');
    });

    it('shows forecast warnings when present', () => {
      const withWarning: PyodideTimeSeriesResult = {
        ...forecastArima,
        arima: {
          ...forecastArima.arima!,
          forecast: {
            ...forecastArima.arima!.forecast!,
            warnings: ['statsmodels no devolvió intervalos de confianza para este forecast.'],
          },
        },
      };
      renderProTimeSeriesResult(withWarning);
      const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
      expect(text).toContain('no devolvió intervalos de confianza');
    });

    it('shows a controlled forecast error while keeping the ARIMA result and diagnostics', () => {
      renderProTimeSeriesResult({
        ...arimaResult,
        arima: {
          ...arima,
          forecastError:
            'No se pudo calcular el forecast para este modelo. El ARIMA fue estimado, pero statsmodels no pudo generar predicciones futuras.',
        },
      });
      const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
      // Forecast error visible…
      expect(text).toContain('No se pudo calcular el forecast');
      // …but the ARIMA summary and coefficients are still there…
      expect(text).toContain('ARIMA(1,1,1)');
      expect(text).toContain('AIC');
      expect(text).toContain('ar.L1');
      // …and the diagnostics are untouched.
      expect(document.getElementById('qb-pro-ts-adf')?.innerHTML).not.toBe('');
      expect(document.getElementById('qb-pro-ts-ljungbox')?.innerHTML).not.toBe('');
      expect(document.getElementById('qb-pro-ts-content')?.style.display).toBe('');
    });

    it('renders no forecast section when the ARIMA has neither forecast nor forecastError', () => {
      renderProTimeSeriesResult(arimaResult);
      const text = document.getElementById('qb-pro-ts-arima-section')?.textContent ?? '';
      expect(text).not.toContain('Forecast ARIMA');
    });
  });
});

describe('renderProTimeSeriesResult · forecast chart', () => {
  // Fake Chart.js: records instances and destroy() calls without touching canvas.
  class MockChart {
    static instances: MockChart[] = [];
    canvas: unknown;
    config: { data: { labels: string[]; datasets: Array<{ label: string; data: Array<number | null> }> } };
    destroyed = false;
    constructor(canvas: unknown, config: MockChart['config']) {
      this.canvas = canvas;
      this.config = config;
      MockChart.instances.push(this);
    }
    destroy(): void { this.destroyed = true; }
  }

  const baseArima: ProArimaResult = {
    order: { p: 1, d: 1, q: 1 },
    converged: true,
    nobs: 39,
    logLikelihood: -55,
    aic: 118,
    bic: 126,
    hqic: 121,
    coefficients: [{ name: 'ar.L1', estimate: 0.6, standardError: 0.12, zStatistic: 5, pValue: 0.001 }],
    warnings: [],
    interpretation: 'ARIMA(1,1,1) combina AR(1), diferenciación d=1 y MA(1).',
  };
  const forecastFull = {
    steps: 3,
    confidenceLevel: 0.95,
    items: [
      { step: 1, mean: 10.5, meanStandardError: 0.8, lower: 8.9, upper: 12.1 },
      { step: 2, mean: 10.7, meanStandardError: 1.1, lower: 8.5, upper: 12.9 },
      { step: 3, mean: 10.8, meanStandardError: 1.3, lower: 8.2, upper: 13.4 },
    ],
    warnings: [],
  };
  const withForecast: PyodideTimeSeriesResult = { ...okResult, arima: { ...baseArima, forecast: forecastFull } };
  const withMonthlyForecast: PyodideTimeSeriesResult = {
    ...withForecast,
    timeIndex: {
      columnName: 'fecha',
      labels: Array.from({ length: 40 }, (_, index) => `2024-${String(index + 1).padStart(2, '0')}`),
      futureLabels: ['2027-05', '2027-06', '2027-07'],
      frequency: 'monthly',
      warnings: [],
    },
    arima: {
      ...baseArima,
      forecast: {
        ...forecastFull,
        items: forecastFull.items.map((item, index) => ({ ...item, period: ['2027-05', '2027-06', '2027-07'][index] })),
      },
    },
  };
  const noForecast: PyodideTimeSeriesResult = { ...okResult, arima: baseArima };
  const observed = Array.from({ length: 40 }, (_, i) => i * 0.5 + Math.sin(i));

  function installChart(): void {
    MockChart.instances = [];
    (globalThis as unknown as { Chart: unknown }).Chart = MockChart;
  }

  afterEach(() => {
    destroyProForecastChart();
    delete (globalThis as unknown as { Chart?: unknown }).Chart;
    MockChart.instances = [];
  });

  it('shows the chart section and the pedagogical note when a valid forecast exists', () => {
    renderProTimeSeriesResult(withForecast, observed);
    expect(document.getElementById('qb-pro-ts-forecast-chart-section')?.style.display).toBe('');
    const note = document.getElementById('qb-pro-ts-forecast-chart-note')?.textContent ?? '';
    expect(note).toContain('últimos valores observados');
    expect(note).toContain('bandas');
  });

  it('hides the chart section when there is no forecast', () => {
    renderProTimeSeriesResult(noForecast, observed);
    expect(document.getElementById('qb-pro-ts-forecast-chart-section')?.style.display).toBe('none');
  });

  it('does not crash and shows a controlled message when Chart.js is unavailable', () => {
    // No Chart global installed (jsdom default).
    expect(() => renderProTimeSeriesResult(withForecast, observed)).not.toThrow();
    const status = document.getElementById('qb-pro-ts-forecast-chart-status')?.textContent ?? '';
    expect(status).toContain('librería de gráficos no está disponible');
    // The forecast table and diagnostics still render.
    expect(document.getElementById('qb-pro-ts-arima-section')?.textContent).toContain('Forecast ARIMA');
    expect(document.getElementById('qb-pro-ts-adf')?.innerHTML).not.toBe('');
  });

  it('builds observed + mean + band datasets when Chart.js is present and intervals are complete', () => {
    installChart();
    renderProTimeSeriesResult(withMonthlyForecast, observed);
    expect(MockChart.instances).toHaveLength(1);
    const labels = MockChart.instances[0].config.data.labels;
    const datasetLabels = MockChart.instances[0].config.data.datasets.map(d => d.label);
    // Observed window is min(30, 40) = 30 points, plus 3 forecast steps.
    expect(labels).toContain('2024-40');
    expect(labels).toContain('2027-07');
    expect(datasetLabels).toContain('Observado');
    expect(datasetLabels).toContain('Forecast');
    expect(datasetLabels).toContain('Límite inferior');
    expect(datasetLabels).toContain('Límite superior');
    // No incomplete-interval status when the band is drawn.
    expect(document.getElementById('qb-pro-ts-forecast-chart-status')?.textContent).toBe('');
  });

  it('draws only the mean (no band) and warns when intervals are incomplete — never invents them', () => {
    installChart();
    const partial: PyodideTimeSeriesResult = {
      ...okResult,
      arima: {
        ...baseArima,
        forecast: {
          steps: 2,
          confidenceLevel: 0.95,
          items: [
            { step: 1, mean: 10.5, lower: 8.9, upper: 12.1 },
            { step: 2, mean: 10.7, lower: null, upper: null },
          ],
          warnings: [],
        },
      },
    };
    renderProTimeSeriesResult(partial, observed);
    const datasetLabels = MockChart.instances[0].config.data.datasets.map(d => d.label);
    expect(datasetLabels).toContain('Observado');
    expect(datasetLabels).toContain('Forecast');
    expect(datasetLabels).not.toContain('Límite inferior');
    expect(datasetLabels).not.toContain('Límite superior');
    const status = document.getElementById('qb-pro-ts-forecast-chart-status')?.textContent ?? '';
    expect(status).toContain('no devolvió intervalos completos');
  });

  it('destroys the previous chart on recalculation instead of duplicating it', () => {
    installChart();
    renderProTimeSeriesResult(withForecast, observed);
    renderProTimeSeriesResult(withForecast, observed);
    // Two constructions, and the first instance was destroyed.
    expect(MockChart.instances).toHaveLength(2);
    expect(MockChart.instances[0].destroyed).toBe(true);
    expect(MockChart.instances[1].destroyed).toBe(false);
  });

  it('plots the forecast even with no observed values passed (mean-only history)', () => {
    installChart();
    renderProTimeSeriesResult(withForecast);
    expect(MockChart.instances).toHaveLength(1);
    const datasetLabels = MockChart.instances[0].config.data.datasets.map(d => d.label);
    expect(datasetLabels).toContain('Forecast');
  });

  it('clearProTimeSeriesResult destroys the chart and hides its section', () => {
    installChart();
    renderProTimeSeriesResult(withForecast, observed);
    const chart = MockChart.instances[0];
    clearProTimeSeriesResult();
    expect(chart.destroyed).toBe(true);
    expect(document.getElementById('qb-pro-ts-forecast-chart-section')?.style.display).toBe('none');
  });

  it('keeps the forecast table intact alongside the chart', () => {
    installChart();
    renderProTimeSeriesResult(withForecast, observed);
    expect(document.getElementById('qb-pro-ts-arima-section')?.textContent).toContain('Forecast ARIMA');
    expect(document.getElementById('qb-pro-ts-adf')?.innerHTML).not.toBe('');
    expect(document.getElementById('qb-pro-ts-ljungbox')?.innerHTML).not.toBe('');
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

  it('populates the optional time-column selector with a no-date fallback', () => {
    renderProTimeSeriesSelectors(csv);
    const select = document.getElementById('qb-pro-ts-date') as HTMLSelectElement;
    const options = Array.from(select.options).map(o => o.value);
    expect(options[0]).toBe('');
    expect(options).toContain('fecha');
    expect(getSelectedProTimeSeriesDateColumn()).toBeNull();
    select.value = 'fecha';
    expect(getSelectedProTimeSeriesDateColumn()).toBe('fecha');
  });

  it('renders the time index block with frequency and pedagogical note', () => {
    renderProTimeSeriesResult({
      ...okResult,
      timeIndex: {
        columnName: 'fecha',
        labels: ['2024-01', '2024-02'],
        futureLabels: ['2024-03'],
        frequency: 'monthly',
        warnings: [],
      },
    });
    const text = document.getElementById('qb-pro-ts-time-index')?.textContent ?? '';
    expect(text).toContain('Índice temporal');
    expect(text).toContain('fecha');
    expect(text).toContain('mensual');
    expect(text).toContain('ordena la serie por fecha');
  });

  it('renders an unknown-frequency warning in the time index block', () => {
    renderProTimeSeriesResult({
      ...okResult,
      timeIndex: {
        columnName: 'fecha',
        labels: ['2024-01', '2024-03'],
        futureLabels: ['t+1'],
        frequency: 'unknown',
        warnings: ['No se pudo inferir una frecuencia temporal regular.'],
      },
    });
    const text = document.getElementById('qb-pro-ts-time-index')?.textContent ?? '';
    expect(text).toContain('no detectada');
    expect(text).toContain('pasos futuros');
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

  it('getProArimaEnabled reflects the "Estimar ARIMA" checkbox', () => {
    renderProTimeSeriesSelectors(csv);
    const checkbox = document.getElementById('qb-pro-ts-arima-enable') as HTMLInputElement;
    expect(getProArimaEnabled()).toBe(false);
    checkbox.checked = true;
    expect(getProArimaEnabled()).toBe(true);
  });

  it('getProArimaOrder reads p, d, q from the inputs, defaulting empty fields', () => {
    renderProTimeSeriesSelectors(csv);
    (document.getElementById('qb-pro-ts-arima-p') as HTMLInputElement).value = '2';
    (document.getElementById('qb-pro-ts-arima-d') as HTMLInputElement).value = '1';
    (document.getElementById('qb-pro-ts-arima-q') as HTMLInputElement).value = '';
    // p=2, d=1 read from inputs; empty q falls back to the default (1).
    expect(getProArimaOrder()).toEqual({ p: 2, d: 1, q: 1 });
  });

  it('getProForecastSteps reads the horizon input, defaulting to 12 when empty', () => {
    renderProTimeSeriesSelectors(csv);
    const input = document.getElementById('qb-pro-ts-forecast-steps') as HTMLInputElement;
    input.value = '24';
    expect(getProForecastSteps()).toBe(24);
    input.value = '';
    expect(getProForecastSteps()).toBe(12);
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
