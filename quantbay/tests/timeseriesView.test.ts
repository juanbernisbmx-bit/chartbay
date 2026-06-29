import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getACFMaxLag,
  getMovingAverageWindow,
  getSelectedTimeSeriesTransformation,
  getTimeSeriesColumnDefaults,
  getTimeSeriesValueColumns,
  renderTimeSeriesAnalysis,
  syncTimeSeriesTransformationControls,
} from '../src/ui/timeseriesView';
import type { ParsedCSV } from '../src/csvParser';
import { runTimeSeriesAnalysis } from '../src/timeseries/service';

let lastChartConfig: any = null;

function installTimeSeriesDom(): void {
  document.body.innerHTML = `
    <div id="qb-ts-panel"></div>
    <div id="qb-ts-empty"></div>
    <div id="qb-ts-controls"></div>
    <select id="qb-ts-date"></select>
    <select id="qb-ts-value"></select>
    <button id="qb-ts-run"></button>
    <div id="qb-ts-warnings"></div>
    <div id="qb-ts-summary"></div>
    <select id="qb-ts-transform">
      <option value="original">Original series</option>
      <option value="difference">Simple difference</option>
      <option value="percentReturn">Percent return</option>
      <option value="logReturn">Log return</option>
      <option value="base100">Base-100 index</option>
      <option value="movingAverage">Simple moving average</option>
    </select>
    <div id="qb-ts-ma-window-wrap"></div>
    <input id="qb-ts-ma-window" type="number" value="3">
    <div id="qb-ts-transform-summary"></div>
    <input id="qb-ts-acf-max-lag" type="number" value="2">
    <div id="qb-ts-acf-warnings"></div>
    <div id="qb-ts-acf-table"></div>
    <div id="qb-ts-acf-interpretation"></div>
    <canvas id="qb-ts-chart"></canvas>
    <div id="qb-ts-interpretation"></div>
  `;
  lastChartConfig = null;
  (globalThis as any).Chart = vi.fn().mockImplementation((_canvas, config) => {
    lastChartConfig = config;
    return { resize: vi.fn(), destroy: vi.fn() };
  });
  (globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  };
  (globalThis as any).cancelAnimationFrame = vi.fn();
}

describe('timeseriesView helpers', () => {
  beforeEach(() => installTimeSeriesDom());

  const data: ParsedCSV = {
    headers: ['date', 'close', 'label'],
    numericColumns: [],
    rows: [
      { date: '2024-01-01', close: 100, label: 'a' },
      { date: '2024-01-02', close: null, label: 'b' },
      { date: '2024-01-03', close: 110, label: 'c' },
    ],
  };

  it('keeps value columns with partial missing values selectable', () => {
    expect(getTimeSeriesValueColumns(data.rows, data.headers, 'date')).toEqual(['close']);
  });

  it('selects detected date and first numeric-like value column by default', () => {
    expect(getTimeSeriesColumnDefaults(data)).toMatchObject({
      dateColumn: 'date',
      valueColumn: 'close',
      valueColumns: ['close'],
      detectedDateColumn: 'date',
    });
  });

  it('reads transformation selector and toggles moving-average controls', () => {
    const select = document.getElementById('qb-ts-transform') as HTMLSelectElement;
    const wrap = document.getElementById('qb-ts-ma-window-wrap') as HTMLElement;
    const input = document.getElementById('qb-ts-ma-window') as HTMLInputElement;
    const acfInput = document.getElementById('qb-ts-acf-max-lag') as HTMLInputElement;

    select.value = 'movingAverage';
    input.value = '4';
    syncTimeSeriesTransformationControls(10);

    expect(getSelectedTimeSeriesTransformation()).toBe('movingAverage');
    expect(getMovingAverageWindow()).toBe(4);
    expect(getACFMaxLag()).toBe(2);
    expect(wrap.style.display).toBe('');
    expect(input.max).toBe('9');
    expect(acfInput.max).toBe('4');

    select.value = 'difference';
    syncTimeSeriesTransformationControls(10);
    expect(wrap.style.display).toBe('none');
  });

  it('renders transformed values into the chart, summary, warnings and interpretation', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 100 },
        { date: '2024-01-02', close: 110 },
        { date: '2024-01-03', close: 121 },
      ],
      { dateColumn: 'date', valueColumn: 'close', transformation: 'percentReturn' }
    );

    renderTimeSeriesAnalysis(result);

    expect(lastChartConfig.data.datasets[0].label).toBe('Percent return');
    expect(lastChartConfig.data.datasets[0].data).toEqual([10, 10]);
    expect(lastChartConfig.data.labels).toEqual(['2024-01-02', '2024-01-03']);
    expect(document.getElementById('qb-ts-transform-summary')?.textContent).toContain('Percent return');
    expect(document.getElementById('qb-ts-transform-summary')?.textContent).toContain('2');
    expect(document.getElementById('qb-ts-warnings')?.textContent).toMatch(/reduce/i);
    expect(document.getElementById('qb-ts-interpretation')?.textContent).toMatch(/relative period-to-period/i);
  });

  it('shows log-return warning for non-positive values', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 100 },
        { date: '2024-01-02', close: 0 },
        { date: '2024-01-03', close: 121 },
      ],
      { dateColumn: 'date', valueColumn: 'close', transformation: 'logReturn' }
    );

    renderTimeSeriesAnalysis(result);

    expect(lastChartConfig).toBeNull();
    expect(document.getElementById('qb-ts-warnings')?.textContent).toMatch(/positive/i);
    expect(document.getElementById('qb-ts-interpretation')?.textContent).toMatch(/continuously compounded/i);
  });

  it('renders ACF threshold and outside-threshold diagnostics', () => {
    const result = runTimeSeriesAnalysis(
      [
        { date: '2024-01-01', close: 1 },
        { date: '2024-01-02', close: -1 },
        { date: '2024-01-03', close: 1 },
        { date: '2024-01-04', close: -1 },
        { date: '2024-01-05', close: 1 },
        { date: '2024-01-06', close: -1 },
      ],
      { dateColumn: 'date', valueColumn: 'close', acfMaxLag: 1 }
    );

    renderTimeSeriesAnalysis(result);

    expect(document.getElementById('qb-ts-acf-table')?.textContent).toContain('0.800167');
    expect(document.getElementById('qb-ts-acf-table')?.textContent).toContain('Si');
    expect(document.getElementById('qb-ts-acf-interpretation')?.textContent).toMatch(/negative autocorrelation/i);
  });

  it('updates ACF diagnostics when the transformation changes', () => {
    const rows = [
      { date: '2024-01-01', close: 1 },
      { date: '2024-01-02', close: 2 },
      { date: '2024-01-03', close: 4 },
      { date: '2024-01-04', close: 8 },
      { date: '2024-01-05', close: 16 },
      { date: '2024-01-06', close: 32 },
    ];

    renderTimeSeriesAnalysis(runTimeSeriesAnalysis(rows, {
      dateColumn: 'date',
      valueColumn: 'close',
      transformation: 'original',
      acfMaxLag: 2,
    }));
    const originalText = document.getElementById('qb-ts-acf-table')?.textContent ?? '';

    renderTimeSeriesAnalysis(runTimeSeriesAnalysis(rows, {
      dateColumn: 'date',
      valueColumn: 'close',
      transformation: 'difference',
      acfMaxLag: 99,
    }));
    const differenceText = document.getElementById('qb-ts-acf-table')?.textContent ?? '';

    expect(originalText).not.toEqual(differenceText);
    expect(document.getElementById('qb-ts-acf-warnings')?.textContent).toMatch(/meaningfully smaller/i);
  });
});