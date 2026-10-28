// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('chart.js/auto', () => ({ default: vi.fn() }));
vi.mock('lucide', () => ({ createIcons: vi.fn(), Search: {}, X: {}, Database: {}, ArrowRight: {}, Download: {}, Info: {}, Trash2: {}, RotateCcw: {}, FileJson: {} }));
vi.mock('../../src/services/datasetHandoff', () => ({ putHandoff: vi.fn() }));

function series(id: string, values = false) {
  return { id, name: `Serie ${id}`, topic: 'Actividad', level: 'Nacional', territory: 'Argentina',
    classification: 'Fuente', frequency: 'Mensual', unit: 'Índice', basis: 'Base original',
    source_id: 'TEST', source: 'Fuente oficial', source_url: 'https://example.org', pending: '',
    release_id: 'prueba-2026', available: true, status: 'Publicado', start: '2026-01-01', end: '2026-04-01', count: 4,
    original: null, license: 'CC BY 4.0', sheet: null, source_row: null, normalization_notes: [],
    observations: values ? [1, 2, 3, 4].map(month => ({ date: `2026-0${month}-01`, value: 100 + month })) : [] };
}
const page = (number: number) => ({ ok: true, schema_version: 1, source: 'supabase', paginated: true,
  release_id: 'Publicaciones vigentes', total: 51, catalog_total: 51, page: number, page_size: 50,
  topics: ['Actividad'], levels: ['Nacional'], series: [series(number === 1 ? 'primera' : 'segunda')] });

beforeEach(() => {
  vi.resetModules();
  const saved = new Map<string,string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => saved.set(k,v), clear: () => saved.clear() });
  document.body.innerHTML = readFileSync('../web/templates/economic_database.html', 'utf8');
  document.body.setAttribute('data-db-page','');
  Object.defineProperty(document,'readyState',{ configurable: true,get: () => 'complete' });
});

it('abre solo metadatos y carga los valores al seleccionar; conserva la selección al cambiar de página', async () => {
  const fetcher = vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.includes('/serie/') ? { ok: true, series: series(url.split('/').slice(-1)[0], true) } : page(url.includes('page=2') ? 2 : 1) }));
  vi.stubGlobal('fetch', fetcher);
  // El runner comparte document con review.test; evitar volver a disparar sus listeners.
  Object.defineProperty(document,'readyState',{ configurable: true,get: () => 'complete' });
  await import('../../src/database.entry');
  await vi.waitFor(() => expect(document.querySelector('[data-series="primera"]')).not.toBeNull());
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(document.getElementById('db-page-status')?.textContent).toBe('Página 1 de 2');
  const checkbox = document.querySelector<HTMLInputElement>('[data-series="primera"]')!;
  checkbox.checked = true; checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledWith('/api/base-datos/serie/primera'));
  await vi.waitFor(() => expect((document.getElementById('db-csv') as HTMLButtonElement).disabled).toBe(false));
  document.getElementById('db-next')!.click();
  await vi.waitFor(() => expect(document.querySelector('[data-series="segunda"]')).not.toBeNull());
  expect(document.getElementById('db-selected')?.textContent).toContain('primera');
  expect(document.getElementById('db-page-status')?.textContent).toBe('Página 2 de 2');
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/serie/'))).toHaveLength(1);
});

it('conserva la selección guardada si una serie de otra página falla temporalmente',async () => {
  const saved=JSON.stringify({ selection:[{ id:'otra_pagina',transform:'level',lag:0 }],completeOnly:true });
  localStorage.setItem('chartbay.database.selection.v1',saved);
  vi.stubGlobal('fetch',vi.fn(async (url: string) => url.includes('/serie/')
    ? { ok:false,status:503,json:async () => ({ok:false,error:'Volvé a intentar.'}) }
    : { ok:true,status:200,json:async () => page(1) }));
  await import('../../src/database.entry');
  await vi.waitFor(() => expect((document.getElementById('db-retry') as HTMLButtonElement).hidden).toBe(false));
  expect(localStorage.getItem('chartbay.database.selection.v1')).toBe(saved);
});
