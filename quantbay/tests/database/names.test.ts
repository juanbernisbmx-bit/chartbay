// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { databaseColumnLabels, type DatabaseHandoff } from '../../src/services/datasetHandoff';
import { renderPreview, renderVarSelectors } from '../../src/ui/tables';
import { runRegressionMode } from '../../src/modes/regressionMode';
import type { ParsedCSV } from '../../src/csvParser';

const metadata = (...names: string[]): DatabaseHandoff => ({
  source: 'database', mode: 'regression', yName: 'ar_y', xNames: ['ar_x'],
  releaseId: 'test', preparedAt: '2026-10-28', rows: 8, start: '2026-01-01', end: '2026-08-01',
  excludedMonths: [], incompleteMonths: [],
  series: names.map((name, i) => ({
    id: i === 0 ? 'ar_y' : 'ar_x', column: i === 0 ? 'ar_y' : 'ar_x', name,
    unit: 'Índice', transform: 'Nivel original', lag: 0, source: 'INDEC', sourceUrl: '',
    originalUrl: null, sha256: null, retrievedAt: null, publishedAt: null, normalizationNotes: [],
  })),
});

beforeEach(() => {
  document.body.innerHTML = '<select id="qb-y"></select><div id="qb-x-checks"></div><div id="qb-table-wrap"></div>';
});

it('permite elegir Y y X por sus nombres sin cambiar las claves usadas para estimar', () => {
  const labels = databaseColumnLabels(metadata('Índice de precios al consumidor', 'Salarios registrados'));
  const data: ParsedCSV = { headers: ['ar_y', 'ar_x'], numericColumns: ['ar_y', 'ar_x'],
    rows: [5, 6, 10, 10, 13, 14, 18, 18].map((y, i) => ({ ar_y: y, ar_x: i + 1 })) };
  renderPreview(data, labels);
  renderVarSelectors(data.numericColumns, [], labels);
  const y = document.querySelector<HTMLSelectElement>('#qb-y')!;
  const x = document.querySelector<HTMLInputElement>('.qb-x-cb[value="ar_x"]')!;
  expect(Array.from(y.options, o => o.text)).toEqual(['Índice de precios al consumidor', 'Salarios registrados']);
  expect(x.closest('label')?.textContent).toContain('Salarios registrados');
  expect(y.value).toBe('ar_y');
  expect(x.checked).toBe(true);
  expect(document.querySelector('th')?.textContent).toBe('Índice de precios al consumidor');
  const result = runRegressionMode(data, y.value, [x.value], undefined).result;
  expect(result.yName).toBe('ar_y');
  expect(result.featureNames).toEqual(['ar_x']);
  expect(result.nObs).toBe(8);
  expect(result.coefficients.every(Number.isFinite)).toBe(true);
});

it('identifica transformaciones y rezagos, y distingue nombres duplicados', () => {
  const duplicate = metadata('IPC', 'IPC');
  expect([...databaseColumnLabels(duplicate).values()]).toEqual(['IPC (ar_y)', 'IPC (ar_x)']);
  duplicate.series[1].transform = 'Variación mensual (%)';
  duplicate.series[1].lag = 1;
  expect(databaseColumnLabels(duplicate).get('ar_x')).toBe('IPC · Variación mensual (%) · Rezago 1 mes');
});

it('trata nombres como texto y no deja etiquetas de la base al cargar otro CSV', () => {
  const labels = databaseColumnLabels(metadata('IPC <img src=x onerror=alert(1)>', 'Salarios "privados"'));
  renderVarSelectors(['ar_y', 'ar_x'], [], labels);
  expect(document.querySelector('img')).toBeNull();
  expect(document.querySelector('option')?.textContent).toContain('<img');
  renderVarSelectors(['ingreso', 'educacion']);
  renderPreview({ headers: ['ingreso'], rows: [{ ingreso: 10 }], numericColumns: ['ingreso'] });
  expect(document.querySelector('option')?.textContent).toBe('ingreso');
  expect(document.querySelector('th')?.textContent).toBe('ingreso');
  expect(document.body.textContent).not.toContain('Salarios');
});
