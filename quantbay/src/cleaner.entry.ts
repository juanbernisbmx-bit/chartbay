import './cleaner.legacy';
import { AdvancedView, type ExportFormat } from './dataCleaner/advancedView';
import { DEFAULT_RULES, type ColumnType, type Review, type Rules, type Source } from './dataCleaner/model';
import type { Request } from './dataCleaner/worker';
import { deleteStorage } from './dataCleaner/storage';
import { putHandoff } from './services/datasetHandoff';
type Command = Request extends infer T ? T extends Request ? Omit<T, 'id'> : never : never;
type Reply = { review: Review | null; source?: Source; undo?: number };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(`dc-${id}`) as T;
let advanced: AdvancedView | null = null;
let worker: Worker | null = null, selected: File | null = null, database = '', busy = false, working = false;
let review: Review | null = null, source: Source | null = null, applied = false, dirty = false, undoCount = 0, sequence = 0;
let pending: { id: number; resolve: (value: unknown) => void; reject: (e: Error) => void } | null = null;
const types: Rules['types'] = {};
const number = (n: number) => n.toLocaleString('es-AR', { maximumFractionDigits: 3 });
function status(text: string): void { $('status').textContent = text; }
function controls(): void {
  const locked = busy || working;
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-data-cleaner] input, [data-data-cleaner] select, [data-data-cleaner] button').forEach(el => { el.disabled = locked; });
  $<HTMLSelectElement>('sheet').disabled = locked || !selected || !/\.xlsx$/i.test(selected.name);
  $<HTMLButtonElement>('import').disabled = locked || !selected;
  $<HTMLButtonElement>('apply').disabled = locked || !review || dirty || applied;
  $<HTMLButtonElement>('undo').disabled = locked || !undoCount;
  for (const id of ['download', 'audit', 'handoff']) $<HTMLButtonElement>(id).disabled = locked || !applied || dirty;
  $('cancel').hidden = !busy; $<HTMLButtonElement>('cancel').disabled = false;
  $('progress').hidden = !busy;
  advanced?.controls(locked, dirty);
  $('state').textContent = dirty ? 'Opciones modificadas · actualizá la vista previa' : applied ? 'Cambios aplicados' : 'Vista previa · sin aplicar';
}
function startWorker(): Worker {
  if (worker) return worker;
  worker = new Worker('/static/js/quantbay.data-cleaner.worker.js');
  worker.onmessage = ({ data }) => {
    if (data.id !== pending?.id) return;
    if (data.kind === 'progress') { status(`${data.stage}… ${Math.round(data.fraction * 100)} %`); $<HTMLProgressElement>('progress').value = data.fraction; return; }
    const active = pending!; pending = null;
    if (data.kind === 'done') active.resolve(data.result);
    else active.reject(new Error(data.message));
  };
  worker.onerror = event => {
    pending?.reject(new Error(event.message || 'El proceso falló. Volvé a importar el archivo.'));
    pending = null; worker?.terminate(); worker = null;
    review = null; applied = false; undoCount = 0;
  };
  return worker;
}
async function call<T>(command: Command): Promise<T> {
  if (pending) throw new Error('Esperá a que termine la operación actual.');
  busy = true; controls();
  try {
    return await new Promise<T>((resolve, reject) => {
      const active = startWorker();
      pending = { id: ++sequence, resolve: value => resolve(value as T), reject };
      try { active.postMessage({ ...command, id: sequence }); }
      catch (error) { pending = null; reject(error); }
    });
  } finally { busy = false; controls(); }
}
async function cleanup(): Promise<void> {
  worker?.terminate(); worker = null;
  if (database) {
    const previous = database; database = '';
    await deleteStorage(previous).catch(() => undefined);
    await deleteStorage(previous + '-reference').catch(() => undefined);
    if (navigator.storage?.getDirectory) {
      const root = await navigator.storage.getDirectory().catch(() => null);
      await root?.removeEntry(previous, { recursive: true }).catch(() => undefined);
    }
  }
}
function getRules(): Rules {
  return {
    ...advanced?.getRules(),
    normalizeHeaders: $<HTMLInputElement>('headers').checked,
    trimText: $<HTMLInputElement>('trim').checked,
    normalizeIdentifiers: $<HTMLInputElement>('tax').checked,
    dropDuplicates: $<HTMLInputElement>('duplicates').checked,
    missing: $<HTMLSelectElement>('missing').value as Rules['missing'],
    invalid: $<HTMLSelectElement>('invalid').value as Rules['invalid'], types: { ...types },
  };
}
function setRules(rules: Rules): void {
  advanced?.setRules(rules);
  $<HTMLInputElement>('headers').checked = rules.normalizeHeaders;
  $<HTMLInputElement>('trim').checked = rules.trimText;
  $<HTMLInputElement>('tax').checked = rules.normalizeIdentifiers;
  $<HTMLInputElement>('duplicates').checked = rules.dropDuplicates;
  $<HTMLSelectElement>('missing').value = rules.missing;
  $<HTMLSelectElement>('invalid').value = rules.invalid;
  Object.keys(types).forEach(key => delete types[Number(key)]);
  Object.assign(types, rules.types);
}
function markDirty(): void { advanced?.invalidateComparison(); dirty = true; controls(); }
function render(value: Review): void {
  review = value;
  $('results').hidden = false;
  $('summary').textContent = `${source?.name ?? ''}${source?.sheet ? ' · ' + source.sheet : ''} · ${number(value.rowsIn)} filas · ${number(value.profiles.length)} columnas · ${number(value.duplicates)} duplicados exactos.`;
  $('warnings').textContent = [...(source?.warnings ?? []), ...value.profiles.filter(p => p.ambiguous).map(p => `${p.name}: separador decimal ambiguo; se conserva la escritura original. Estadísticas calculadas con decimal ${p.decimal === '.' ? 'punto' : 'coma'}.`)].join('\n');
  $('columns').replaceChildren();
  value.profiles.forEach((p, index) => {
    const row = document.createElement('tr');
    cell(row, p.name);
    const td = document.createElement('td'), select = document.createElement('select');
    select.setAttribute('aria-label', `Tipo esperado de ${p.name}`);
    (['texto', 'número', 'fecha', 'identificador', 'CUIT/CUIL'] as ColumnType[]).forEach(type => {
      const option = document.createElement('option'); option.value = type; option.textContent = type; option.selected = type === p.type; select.append(option);
    });
    select.addEventListener('change', () => { types[index] = select.value as ColumnType; markDirty(); });
    td.append(select); row.append(td);
    [p.present, p.missing].forEach(n => cell(row, number(n)));
    cell(row, number(p.invalid) + (p.invalidExamples.length ? '\n' + p.invalidExamples.map(e => `Fila ${e.row}: ${e.value}`).join('\n') : ''));
    cell(row, number(p.dirty));
    cell(row, (p.uniqueCapped ? '≥ ' : '') + number(p.unique));
    cell(row, p.min === null ? '—' : `${number(p.min)} / ${number(p.max!)} / ${number(p.mean!)}`);
    $('columns').append(row);
  });
  $('proposal').textContent = `${number(value.changedCells)} celdas cambiarían · ${number(value.removedRows)} filas se eliminarían · ${number(value.rowsOut)} filas de salida. ${value.preview.length ? 'Primeros cambios:' : 'No hay cambios propuestos.'}`;
  $('preview-rows').replaceChildren();
  for (const c of value.preview) {
    const row = document.createElement('tr');
    [String(c.row), c.column, c.before || '(vacío)', c.after || '(vacío)', c.reason].forEach(text => cell(row, text));
    $('preview-rows').append(row);
  }
  advanced?.render(value);
  controls();
}
function cell(row: HTMLTableRowElement, text: string): void { const td = document.createElement('td'); td.textContent = text; row.append(td); }
async function chooseFile(): Promise<void> {
  const file = $<HTMLInputElement>('file').files?.[0];
  if (!file) return;
  await cleanup(); advanced?.reset();
  selected = file; review = null; source = null; applied = false; dirty = false; undoCount = 0;
  $('results').hidden = true; setRules(structuredClone(DEFAULT_RULES));
  $<HTMLSelectElement>('sheet').replaceChildren();
  if (/\.csv$/i.test(file.name)) { const option = document.createElement('option'); option.textContent = 'Solo para Excel'; $('sheet').append(option); }
  if (!/\.(csv|xlsx)$/i.test(file.name)) { selected = null; throw new Error('Elegí un CSV o Excel .xlsx.'); }
  if (/\.xlsx$/i.test(file.name)) {
    status('Leyendo hojas de Excel…');
    const sheets = await call<{ name: string }[]>({ kind: 'sheets', file });
    for (const sheet of sheets) { const option = document.createElement('option'); option.textContent = sheet.name; option.value = sheet.name; $('sheet').append(option); }
  }
  status(`${file.name} · ${number(file.size / 1024 / 1024)} MiB. Listo para importar.`); controls();
}
async function importFile(): Promise<void> {
  if (!selected) return;
  await cleanup(); advanced?.reset();
  review = null; applied = false; undoCount = 0; dirty = false; $('results').hidden = true;
  database = 'chartbay-cleaner-' + crypto.randomUUID();
  try { sessionStorage.setItem('chartbay-cleaner-session', database); } catch { /* privacy mode */ }
  const estimate = await navigator.storage?.estimate?.();
  if (estimate?.quota) $('storage').textContent = `Espacio temporal estimado disponible: ${number(Math.max(0, estimate.quota - (estimate.usage ?? 0)) / 1024 ** 3)} GiB. Se usan bloques de hasta 256 filas o 512 KiB, muestras acotadas y disco para datos y duplicados. Máximo 4 MiB por fila y 4096 columnas.`;
  status('Importando…');
  try {
    const reply = await call<Reply>({ kind: 'import', file: selected, database,
      options: { sheet: /\.xlsx$/i.test(selected.name) ? $<HTMLSelectElement>('sheet').value : undefined,
        encoding: $<HTMLSelectElement>('encoding').value, delimiter: $<HTMLSelectElement>('delimiter').value.replace('tab', '\t') }, rules: getRules() });
    source = reply.source!; render(reply.review!); status('Perfil completo. Revisá la propuesta antes de aplicar.');
  } catch (error) { await cleanup(); throw error; }
}
async function preview(): Promise<void> {
  dirty = true; advanced?.invalidateComparison(); controls();
  const reply = await call<Reply>({ kind: 'review', rules: getRules() });
  applied = false; dirty = false; render(reply.review!); status('Vista previa actualizada. Los cambios todavía no se aplicaron.');
}
async function apply(): Promise<void> {
  const reply = await call<Reply>({ kind: 'apply' });
  applied = true; undoCount = reply.undo!; render(reply.review!); status('Cambios aplicados. Podés exportar o deshacer.');
}
async function undo(): Promise<void> {
  advanced?.invalidateComparison();
  const reply = await call<Reply>({ kind: 'undo' });
  undoCount = reply.undo!; dirty = false; applied = !!reply.review;
  if (reply.review) { setRules(reply.review.rules); render(reply.review); }
  else {
    setRules({ ...DEFAULT_RULES, normalizeHeaders: false, trimText: false, normalizeIdentifiers: false, types: {} });
    const original = await call<Reply>({ kind: 'review', rules: getRules() });
    render(original.review!);
  }
  status(applied ? 'Se restauró la aplicación anterior.' : 'Se restauraron los valores originales.'); controls();
}
function download(file: Blob, name: string): void {
  const url = URL.createObjectURL(file), a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
}
async function exportFile(format: ExportFormat, handoff = false): Promise<void> {
  const name = (source?.name ?? 'datos').replace(/\.[^.]+$/, '') + (format === 'csv' ? '-limpio.csv' : format === 'comparison' ? '-cruce.json' : format === 'quality' ? '-antes-despues.json' : '-auditoria.json');
  let target: FileSystemFileHandle | undefined;
  const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
  if (picker && !handoff) {
    try { target = await picker({ suggestedName: name, types: [{ description: format === 'csv' ? 'CSV limpio' : 'Auditoría JSON', accept: { [format === 'csv' ? 'text/csv' : 'application/json']: [format === 'csv' ? '.csv' : '.json'] } }] }); }
    catch (error) { if ((error as Error).name === 'AbortError') return; throw error; }
  }
  const reply = await call<{ saved?: boolean; file?: File }>({ kind: 'export', format, target, directory: database, safeForExcel: handoff ? false : $<HTMLInputElement>('safe').checked });
  if (handoff && reply.file) { await putHandoff(name, reply.file); window.location.href = '/econometria'; }
  else if (reply.file) download(reply.file, name);
  status(format === 'csv' ? 'CSV limpio exportado.' : 'Reporte completo exportado.');
}
function action(run: () => Promise<void>): () => void {
  return () => {
    if (busy || working) return;
    working = true; controls();
    void run().catch(error => status(`Error: ${(error as Error).message}`))
      .finally(() => { working = false; controls(); });
  };
}
async function init(): Promise<void> {
  if (!document.querySelector('[data-data-cleaner]')) return;
  try { database = sessionStorage.getItem('chartbay-cleaner-session') ?? ''; await cleanup(); sessionStorage.removeItem('chartbay-cleaner-session'); } catch { /* best effort cleanup after interrupted sessions */ }
  advanced = new AdvancedView({call, run: action, dirty: markDirty, status, getRules, setRules, database: () => database, export: format => exportFile(format)});
  $('file').addEventListener('change', action(chooseFile));
  $('import').addEventListener('click', action(importFile));
  $('preview').addEventListener('click', action(preview));
  $('apply').addEventListener('click', action(apply));
  $('undo').addEventListener('click', action(undo));
  $('rules').addEventListener('change', markDirty);
  $('download').addEventListener('click', action(() => exportFile('csv')));
  $('audit').addEventListener('click', action(() => exportFile('audit')));
  $('handoff').addEventListener('click', action(() => exportFile('csv', true)));
  $('cancel').addEventListener('click', () => { worker?.postMessage({ kind: 'cancel', id: 0 }); status('Cancelando…'); });
  window.addEventListener('pagehide', () => { worker?.terminate(); worker = null; void cleanup(); });
  controls();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void init());
else void init();
