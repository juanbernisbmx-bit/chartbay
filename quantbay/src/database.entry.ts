import Chart from 'chart.js/auto';
import { createIcons, Search, X, Database, ArrowRight, Download, Info, Trash2, RotateCcw, FileJson } from 'lucide';
import { escapeHtml as esc } from './utils/format';
import { putHandoff, type DatabaseHandoff } from './services/datasetHandoff';
import { downloadBlob, prepareDataset, periodLabel, transformLabel, TRANSFORMS, type EconomicSeries, type Selection, type Snapshot, type PreparedDataset, type Transform, type Frequency } from './database/dataset';

const icons = { Search, X, Database, ArrowRight, Download, Info, Trash2, RotateCcw, FileJson };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`db-${id}`) as T;
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
const select = (id: string) => $<HTMLSelectElement>(id);
const STORAGE = 'chartbay.database.selection.v1';
const number = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 4 });
let snapshot: Snapshot;
let selection: Selection[] = [];
let prepared: PreparedDataset | null = null;
let chart: Chart | null = null;
let analysisMode: 'regression' | 'timeseries' = 'regression';
let yId = '';
let currentTab = 'table';
let transferring = false;
let pageSeries: EconomicSeries[] = [];
let pageRequest = 0;
let selectionRequest = 0;
const loadingSeries = new Map<string, Promise<void>>();

function mergeSeries(items: EconomicSeries[]): void {
  const byId = new Map(snapshot.series.map(s => [s.id, s]));
  for (const item of items) {
    const previous = byId.get(item.id);
    byId.set(item.id, previous?.release_id === item.release_id && previous?.observations.length && !item.observations.length
      ? { ...item, observations: previous.observations } : item);
  }
  snapshot.series = [...byId.values()];
}
async function ensureSeries(id: string): Promise<void> {
  if (snapshot.series.find(s => s.id === id)?.observations.length) return;
  let pending = loadingSeries.get(id);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`/api/base-datos/serie/${encodeURIComponent(id)}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok || payload.series?.id !== id || !payload.series.observations?.length) {
        throw Object.assign(new Error(payload.error || 'No se pudo cargar la serie seleccionada.'), { status: response.status });
      }
      mergeSeries([payload.series]);
    })().finally(() => loadingSeries.delete(id));
    loadingSeries.set(id, pending);
  }
  await pending;
}
async function requestPage(page = 1): Promise<void> {
  const request = ++pageRequest;
  $('catalog-status').hidden = false; $('catalog-status').textContent = 'Buscando series...';
  const params = new URLSearchParams({ page: String(page), q: input('search').value.trim(), topic: select('topic').value, level: select('level').value, frequency: select('frequency').value });
  try {
    const response = await fetch(`/api/base-datos/catalogo?${params}`);
    const payload: Snapshot & { ok: boolean; error?: string } = await response.json();
    if (request !== pageRequest) return;
    if (!response.ok || !payload.ok || !payload.paginated || !Array.isArray(payload.series)) throw new Error(payload.error || 'No se pudo buscar.');
    pageSeries = payload.series;
    mergeSeries(payload.series);
    snapshot = { ...payload, series: snapshot.series };
    renderCatalog();
    $('catalog-status').hidden = true;
  } catch (reason) {
    if (request === pageRequest) $('catalog-status').textContent = (reason as Error).message;
  }
}

function refreshIcons(): void { createIcons({ icons, attrs: { 'aria-hidden': 'true' } }); }
function error(message = ''): void { $('prepare-error').textContent = message; $('prepare-error').hidden = !message; }
function persist(): void {
  try { localStorage.setItem(STORAGE, JSON.stringify({ selection, yId, analysisMode, start: input('start').value, end: input('end').value, completeOnly: input('complete').checked })); } catch { /* Selection can remain in memory when storage is unavailable. */ }
}
function restore(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
    if (!saved || !Array.isArray(saved.selection)) return;
    const seen = new Set<string>();
    selection = saved.selection.filter((s: Selection) => {
      if (!s || seen.has(s.id) || !snapshot.series.some(item => item.id === s.id && item.available) ||
          !Object.prototype.hasOwnProperty.call(TRANSFORMS, s.transform) || !Number.isInteger(s.lag) || s.lag < 0 || s.lag > 12) return false;
      seen.add(s.id); return true;
    }).slice(0, 12);
    yId = typeof saved.yId === 'string' ? saved.yId : '';
    analysisMode = saved.analysisMode === 'timeseries' ? 'timeseries' : 'regression';
    syncPeriodInputs();
    input('start').value = typeof saved.start === 'string' ? saved.start : '';
    input('end').value = typeof saved.end === 'string' ? saved.end : '';
    input('complete').checked = saved.completeOnly !== false;
  } catch { selection = []; }
}
function renderCatalog(): void {
  const query = input('search').value.trim().toLocaleLowerCase('es');
  const topic = select('topic').value, level = select('level').value, frequency = select('frequency').value;
  const items = snapshot.paginated ? pageSeries : snapshot.series.filter(s => (!input('ready').checked || s.available) &&
    (!topic || s.topic === topic) && (!level || s.level === level) && (!frequency || s.frequency === frequency) &&
    (!query || `${s.name} ${s.territory} ${s.source}`.toLocaleLowerCase('es').includes(query)));
  $('filter-count').textContent = `${snapshot.paginated ? snapshot.total : items.length} resultados`;
  $('pagination').hidden = !snapshot.paginated;
  if (snapshot.paginated) {
    const page = snapshot.page ?? 1, pages = Math.max(1, Math.ceil((snapshot.total ?? 0) / (snapshot.page_size ?? 50)));
    $('page-status').textContent = `Página ${page} de ${pages}`;
    button('previous').disabled = page <= 1; button('next').disabled = page >= pages;
  }
  $('empty').hidden = items.length > 0;
  $('empty').textContent = snapshot.series.length ? 'Sin series para estos filtros.' : 'Todavía no hay series publicadas disponibles.';
  $('series').innerHTML = items.map(s => {
    const checked = selection.some(choice => choice.id === s.id);
    const coverage = s.available ? `${periodLabel(s.start!, s.frequency as Frequency)} / ${periodLabel(s.end!, s.frequency as Frequency)}` : 'Sin cargar';
    return `<tr data-selected="${checked}"><td><input type="checkbox" data-series="${esc(s.id)}" aria-label="Seleccionar ${esc(s.name)}" ${checked ? 'checked' : ''} ${s.available ? '' : 'disabled'}></td><td><label class="db-series-name">${esc(s.name)}</label><span class="db-series-sub">${esc(s.level)} · ${esc(s.source_id === 'INDEC_IPC' ? 'INDEC' : s.territory)}</span></td><td>${esc(s.frequency)}</td><td>${esc(coverage)}</td><td><button type="button" class="db-icon" data-detail="${esc(s.id)}" title="Ver ficha de ${esc(s.name)}" aria-label="Ver ficha de ${esc(s.name)}"><i data-lucide="info"></i></button></td></tr>`;
  }).join('');
  refreshIcons();
}
function syncPeriodInputs(): void {
  const frequency = (snapshot.series.find(s => s.id === selection[0]?.id)?.frequency ?? 'Mensual') as Frequency;
  for (const id of ['start', 'end']) {
    const type = frequency === 'Diaria' ? 'date' : frequency === 'Anual' ? 'number' : 'month';
    if (input(id).type !== type) { input(id).value = ''; input(id).type = type; }
    if (frequency === 'Anual') { input(id).min = '1800'; input(id).max = String(new Date().getFullYear()); input(id).placeholder = 'AAAA'; }
    else { input(id).removeAttribute('min'); input(id).removeAttribute('max'); }
  }
}
function renderSelection(): void {
  syncPeriodInputs();
  const frequency = (snapshot.series.find(s => s.id === selection[0]?.id)?.frequency ?? 'Mensual') as Frequency;
  $('selection-count').textContent = String(selection.length);
  $('selection-empty').hidden = selection.length > 0;
  button('clear').disabled = selection.length === 0;
  $<HTMLFieldSetElement>('options').disabled = selection.length === 0;
  if (!selection.some(s => s.id === yId)) yId = selection[0]?.id ?? '';
  $('selected').innerHTML = selection.map(choice => {
    const series = snapshot.series.find(s => s.id === choice.id)!;
    return `<li><div class="db-selected-name"><span>${esc(series.name)}</span><button type="button" class="db-icon" data-remove="${esc(choice.id)}" title="Quitar ${esc(series.name)}" aria-label="Quitar ${esc(series.name)}"><i data-lucide="x"></i></button></div><div class="db-transforms"><label>Transformación<select data-transform="${esc(choice.id)}" aria-label="Transformación de ${esc(series.name)}">${Object.entries(TRANSFORMS).map(([key, label]) => `<option value="${key}" ${choice.transform === key ? 'selected' : ''}>${esc(transformLabel(key as Transform, frequency))}</option>`).join('')}</select></label><label>Rezago (${frequency === 'Diaria' ? 'días' : frequency === 'Anual' ? 'años' : 'meses'})<input type="number" min="0" max="12" step="1" data-lag="${esc(choice.id)}" aria-label="Rezago de ${esc(series.name)}" value="${choice.lag}"></label></div></li>`;
  }).join('');
  select('y').innerHTML = selection.map(choice => `<option value="${esc(choice.id)}">${esc(snapshot.series.find(s => s.id === choice.id)!.name)}</option>`).join('');
  select('y').value = yId;
  document.querySelectorAll<HTMLInputElement>('input[name="db-mode"]').forEach(radio => { radio.checked = radio.value === analysisMode; });
  $('y-label').textContent = analysisMode === 'regression' ? 'Variable dependiente (Y)' : 'Serie a analizar';
  $('x-label').textContent = analysisMode === 'regression' ? `${Math.max(0, selection.length - 1)} variables explicativas (X)` : '';
  refreshIcons();
}
function renderChart(): void {
  chart?.destroy(); chart = null;
  if (currentTab !== 'chart' || !prepared?.rows.length) return;
  const palette = ['#1e5fa8', '#168268', '#be6542', '#9466a5', '#cc9d25', '#c14967', '#477d87'];
  chart = new Chart($<HTMLCanvasElement>('chart'), {
    type: 'line',
    data: { labels: prepared.rows.map(r => periodLabel(String(r[0]), prepared!.frequency)), datasets: prepared.columns.map((column, i) => ({
      label: `${column.name.replace('IPC nivel general - ', '')} (${column.unit})`, data: prepared!.rows.map(r => r[i + 1] as number | null), borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length], borderWidth: 1.6, pointRadius: 0, spanGaps: false,
    })) },
    options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } }, scales: { x: { ticks: { maxTicksLimit: 8 }, grid: { display: false } } } },
  });
}
function updatePreview(): void {
  prepared = null; error();
  button('apply').disabled = true; button('csv').disabled = true; button('manifest').disabled = true;
  $('preview-content').hidden = true; $('preview-empty').hidden = false;
  chart?.destroy(); chart = null;
  if (!selection.length) return;
  try {
    prepared = prepareDataset(snapshot, selection, { start: input('start').value, end: input('end').value, completeOnly: input('complete').checked });
    if (!prepared.rows.length || prepared.rows.every(r => r.slice(1).every(v => v === null))) {
      error('No hay observaciones utilizables en este período. Revisá las fechas y transformaciones.'); return;
    }
    $('preview-empty').hidden = true; $('preview-content').hidden = false;
    $('observations').textContent = String(prepared.rows.length);
    $('period').textContent = `${periodLabel(String(prepared.rows[0][0]), prepared.frequency)} / ${periodLabel(String(prepared.rows[prepared.rows.length - 1][0]), prepared.frequency)}`;
    $('excluded').textContent = String(prepared.excludedMonths.length);
    $('preview-head').innerHTML = `<tr><th scope="col">${prepared.frequency === 'Diaria' ? 'Fecha' : prepared.frequency === 'Anual' ? 'Año' : 'Mes'}</th>${prepared.columns.map(c => `<th scope="col" title="${esc(c.column)}">${esc(c.name.replace('IPC nivel general - ', ''))}<span>${esc(transformLabel(c.transform, prepared!.frequency))}${c.lag ? ` · Rezago ${c.lag}` : ''}</span></th>`).join('')}</tr>`;
    $('preview-body').innerHTML = prepared.rows.slice(0, 8).map(row => `<tr>${row.map((value, i) => `<td>${i === 0 ? esc(periodLabel(String(value), prepared!.frequency)) : value === null ? 'Sin dato' : number.format(value as number)}</td>`).join('')}</tr>`).join('');
    $('preview-caption').textContent = `Primeras ${Math.min(8, prepared.rows.length)} de ${prepared.rows.length} observaciones. Frecuencia ${prepared.frequency.toLowerCase()}.`;
    $('missing-details').hidden = prepared.incompleteMonths.length === 0;
    $('missing-summary').textContent = `${prepared.incompleteMonths.length} períodos con datos faltantes o transformación no disponible${input('complete').checked ? ' (excluidos)' : ' (conservados)'}`;
    $('missing-months').textContent = prepared.incompleteMonths.map(month => periodLabel(month, prepared!.frequency)).join(', ');
    $('overlap').hidden = !selection.some(s => s.id === 'ipc_ng_nacional') || !selection.some(s => s.id.startsWith('ipc_ng_') && s.id !== 'ipc_ng_nacional');
    button('csv').disabled = false; button('manifest').disabled = false;
    const completeRows = prepared.rows.filter(r => r.slice(1).every(value => typeof value === 'number' && Number.isFinite(value))).length;
    const enoughColumns = analysisMode === 'timeseries' || selection.length >= 2;
    const enoughRows = completeRows > (analysisMode === 'regression' ? selection.length : 2);
    button('apply').disabled = !enoughColumns || !enoughRows || transferring;
    if (!enoughColumns) error('Para una regresión se necesitan al menos dos series distintas.');
    else if (!enoughRows) error('No hay suficientes observaciones completas para este análisis.');
    renderChart();
  } catch (reason) { prepared = null; error((reason as Error).message); }
}
function changed(rebuildSelection = true): void {
  if (rebuildSelection) renderSelection();
  persist();
  const request = ++selectionRequest;
  if (snapshot.paginated && selection.some(s => !snapshot.series.find(item => item.id === s.id)?.observations.length)) {
    prepared = null; chart?.destroy(); chart = null;
    button('apply').disabled = true; button('csv').disabled = true; button('manifest').disabled = true;
    $('preview-content').hidden = true; $('preview-empty').hidden = false;
    error('Cargando las series seleccionadas...');
    void Promise.all(selection.map(s => ensureSeries(s.id))).then(() => {
      if (request === selectionRequest) { renderSelection(); updatePreview(); }
    }).catch(reason => { if (request === selectionRequest) error((reason as Error).message); });
    return;
  }
  updatePreview();
}
function metadata(): DatabaseHandoff {
  if (!prepared?.rows.length) throw new Error('No hay un conjunto preparado.');
  const selectedY = prepared.columns.find(c => c.id === yId) ?? prepared.columns[0];
  return { source: 'database', mode: analysisMode, yName: selectedY.column,
    xNames: prepared.columns.filter(c => c.id !== selectedY.id).map(c => c.column),
    releaseId: snapshot.release_id, preparedAt: new Date().toISOString(), rows: prepared.rows.length,
    start: String(prepared.rows[0][0]), end: String(prepared.rows[prepared.rows.length - 1][0]),
    excludedMonths: prepared.excludedMonths, incompleteMonths: prepared.incompleteMonths,
    series: prepared.columns.map(column => {
      const series = snapshot.series.find(s => s.id === column.id)!;
      return { ...column, frequency: series.frequency, transform: transformLabel(column.transform, prepared!.frequency), source: series.source,
        sourceUrl: series.source_url, originalUrl: series.original?.url ?? null,
        sha256: series.original?.sha256 ?? null, retrievedAt: series.original?.retrieved_at ?? null,
        publishedAt: series.original?.published_at ?? null, normalizationNotes: series.normalization_notes,
        license: series.license ?? null, licenseUrl: series.license_url ?? null,
        attribution: series.attribution ?? null, releaseId: series.release_id ?? snapshot.release_id };
    }),
  };
}
function showDetail(id: string): void {
  const series = snapshot.series.find(s => s.id === id);
  if (!series) return;
  $('detail-title').textContent = series.name;
  const fields = [['Fuente', series.source], ['Territorio', `${series.territory} (${series.classification})`], ['Frecuencia', series.frequency], ['Unidad', series.unit], ['Base / ajuste', series.basis], ['Estado', series.status], ['Observaciones', String(series.count)], ['Cobertura', series.start ? `${periodLabel(series.start, series.frequency as Frequency)} / ${periodLabel(series.end!, series.frequency as Frequency)}` : 'Pendiente'], ['Pendientes', series.pending]];
  if (series.release_id) fields.push(['Release', series.release_id]);
  if (series.original) {
    if (series.original.published_at) fields.push(['Publicado por la fuente', series.original.published_at]);
    if (series.original.retrieved_at) fields.push(['Captura', series.original.retrieved_at]);
  }
  if (series.sheet) fields.push(['Archivo / hoja', `${series.sheet}${series.source_row ? `, fila ${series.source_row}` : ''}`]);
  if (series.normalization_notes.length) fields.push(['Normalización', series.normalization_notes.join('. ')]);
  if (series.attribution) fields.push(['Atribución', series.attribution]);
  if (series.license) fields.push(['Licencia', series.license]);
  $('detail-body').innerHTML = `<dl>${fields.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`;
  for (const [label, url] of [['Publicación de origen', series.source_url], ['Archivo original', series.original?.url]]) {
    if (url && /^https:\/\//.test(url)) { const p = document.createElement('p'), a = document.createElement('a'); a.textContent = label!; a.href = url; a.target = '_blank'; a.rel = 'noopener'; p.append(a); $('detail-body').append(p); }
  }
  if (series.license_url && /^https:\/\//.test(series.license_url)) { const p = document.createElement('p'), a = document.createElement('a'); a.textContent = 'Texto de la licencia'; a.href = series.license_url; a.target = '_blank'; a.rel = 'noopener'; p.append(a); $('detail-body').append(p); }
  $<HTMLDialogElement>('detail').showModal();
}
async function load(): Promise<void> {
  $('load-status').hidden = false; $('load-status').textContent = 'Cargando catálogo...'; button('retry').hidden = true;
  try {
    const response = await fetch('/api/base-datos/catalogo');
    const payload = await response.json();
    if (!response.ok || !payload.ok || payload.schema_version !== 1 || !Array.isArray(payload.series)) throw new Error(payload.error || 'No se pudo cargar el catálogo.');
    snapshot = payload;
    pageSeries = [...payload.series];
    if (snapshot.paginated) {
      // Restaurar hasta doce selecciones aunque sus fichas estén en otras páginas.
      let saved: { selection?: Selection[] } | null = null;
      try {
        saved = JSON.parse(localStorage.getItem(STORAGE) ?? 'null');
      } catch { /* A malformed saved selection does not prevent loading. */ }
      const choices = Array.isArray(saved?.selection) ? saved.selection : [];
      const ids = [...new Set<string>(choices.map(s => s?.id))]
        .filter(id => typeof id === 'string' && /^[a-z0-9_]{1,100}$/.test(id)).slice(0, 12);
      await Promise.all(ids.map(async id => {
        try { await ensureSeries(id); }
        catch (reason) {
          // Conservar la selección guardada ante fallas transitorias; solo omitir una retirada real.
          if ((reason as { status?: number }).status !== 404) throw reason;
        }
      }));
    }
    button('example').hidden = !['ipc_ng_nacional', 'ipc_ng_pampeana', 'ipc_ng_cuyo'].every(id => snapshot.series.some(s => s.id === id && s.available));
    input('ready').closest('label')!.hidden = snapshot.source !== 'pilot';
    $('origin').textContent = snapshot.source === 'pilot' ? 'Piloto local' : snapshot.source === 'supabase' ? 'Supabase · publicado' : snapshot.source === 'supabase_cache' ? 'Supabase · última lectura' : snapshot.source === 'github' ? 'Copia publicada · GitHub' : 'Sin publicaciones';
    $('release').textContent = snapshot.release_id;
    $('count').textContent = snapshot.paginated ? `${snapshot.catalog_total ?? 0} series publicadas` : `${snapshot.series.length} series · ${snapshot.series.filter(s => s.available).length} cargadas`;
    select('topic').innerHTML = '<option value="">Todos los temas</option>' + (snapshot.topics ?? [...new Set(snapshot.series.map(s => s.topic))].sort()).map(topic => `<option>${esc(topic)}</option>`).join('');
    select('frequency').innerHTML = '<option value="">Todas las frecuencias</option>' + (snapshot.frequencies ?? [...new Set(snapshot.series.map(s => s.frequency))]).map(f => `<option>${esc(f)}</option>`).join('');
    if (snapshot.paginated) select('level').innerHTML = '<option value="">Todas las coberturas</option>' + (snapshot.levels ?? []).map(level => `<option>${esc(level)}</option>`).join('');
    restore(); renderCatalog(); changed();
    $('content').hidden = false; $('load-status').hidden = true;
  } catch (reason) { $('load-status').textContent = (reason as Error).message; button('retry').hidden = false; }
}
function init(): void {
  if (!document.querySelector('[data-db-page]')) return;
  let searchTimer: ReturnType<typeof setTimeout>;
  input('search').addEventListener('input', () => {
    if (!snapshot?.paginated) { if (snapshot) renderCatalog(); return; }
    clearTimeout(searchTimer); searchTimer = setTimeout(() => { void requestPage(); }, 250);
  });
  for (const id of ['topic', 'level', 'frequency', 'ready']) $(id).addEventListener('change', () => {
    if (snapshot?.paginated) void requestPage(); else if (snapshot) renderCatalog();
  });
  button('previous').addEventListener('click', () => { void requestPage((snapshot.page ?? 1) - 1); });
  button('next').addEventListener('click', () => { void requestPage((snapshot.page ?? 1) + 1); });
  $('series').addEventListener('change', event => {
    const checkbox = event.target as HTMLInputElement;
    const id = checkbox.dataset.series;
    if (!id) return;
    if (checkbox.checked) {
      const first = snapshot.series.find(s => s.id === selection[0]?.id);
      const added = snapshot.series.find(s => s.id === id);
      if (first && first.frequency !== added?.frequency) { checkbox.checked = false; error('Para combinarlas, elegí series de la misma frecuencia. Podés vaciar el conjunto y empezar con otra frecuencia.'); return; }
      if (selection.length >= 12) { checkbox.checked = false; error('El máximo es de 12 series por conjunto.'); return; }
      selection.push({ id, transform: snapshot.paginated ? 'level' : 'monthly', lag: 0 });
    } else selection = selection.filter(s => s.id !== id);
    renderCatalog(); changed();
  });
  $('series').addEventListener('click', event => { const id = (event.target as Element).closest<HTMLElement>('[data-detail]')?.dataset.detail; if (id) showDetail(id); });
  $('selected').addEventListener('click', event => {
    const id = (event.target as Element).closest<HTMLElement>('[data-remove]')?.dataset.remove;
    if (!id) return; selection = selection.filter(s => s.id !== id); renderCatalog(); changed();
  });
  $('selected').addEventListener('change', event => {
    const field = event.target as HTMLInputElement;
    const choice = selection.find(s => s.id === (field.dataset.transform ?? field.dataset.lag));
    if (!choice) return;
    if (field.dataset.transform) choice.transform = field.value as Transform;
    else {
      const lag = field.value === '' ? NaN : Number(field.value);
      if (!Number.isInteger(lag) || lag < 0 || lag > 12) { field.value = String(choice.lag); error('El rezago debe ser un entero entre 0 y 12 períodos.'); return; }
      choice.lag = lag;
    }
    changed(false);
  });
  button('clear').addEventListener('click', () => { selection = []; yId = ''; input('start').value = ''; input('end').value = ''; renderCatalog(); changed(); });
  button('example').addEventListener('click', () => {
    selection = ['ipc_ng_nacional', 'ipc_ng_pampeana', 'ipc_ng_cuyo'].filter(id => snapshot.series.some(s => s.id === id && s.available)).map(id => ({ id, transform: 'monthly', lag: 0 }));
    yId = 'ipc_ng_nacional'; renderCatalog(); changed();
  });
  for (const id of ['start', 'end', 'complete']) $(id).addEventListener('change', () => changed(false));
  select('y').addEventListener('change', () => { yId = select('y').value; changed(false); });
  document.querySelectorAll<HTMLInputElement>('input[name="db-mode"]').forEach(radio => radio.addEventListener('change', () => { analysisMode = radio.value === 'timeseries' ? 'timeseries' : 'regression'; changed(); }));
  for (const tab of ['table', 'chart']) button(`tab-${tab}`).addEventListener('click', () => {
    currentTab = tab;
    for (const name of ['table', 'chart']) { $(`${name}-panel`).hidden = name !== tab; button(`tab-${name}`).setAttribute('aria-selected', String(name === tab)); }
    renderChart();
  });
  button('csv').addEventListener('click', () => { if (prepared) downloadBlob(new Blob([prepared.csv], { type: 'text/csv;charset=utf-8' }), `chartbay-${snapshot.release_id}.csv`); });
  button('manifest').addEventListener('click', () => downloadBlob(new Blob([JSON.stringify(metadata(), null, 2)], { type: 'application/json' }), 'chartbay-procedencia.json'));
  button('apply').addEventListener('click', async () => {
    if (!prepared || transferring) return;
    transferring = true; button('apply').disabled = true; error();
    try {
      await putHandoff(`chartbay-${snapshot.release_id}.csv`, prepared.csv, metadata());
      window.location.assign('/econometria?origen=base-datos');
    } catch { error('No se pudo transferir el conjunto. Podés descargar el CSV y cargarlo en Econometría.'); transferring = false; button('apply').disabled = false; }
  });
  button('detail-close').addEventListener('click', () => $<HTMLDialogElement>('detail').close());
  button('retry').addEventListener('click', load);
  refreshIcons(); void load();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
