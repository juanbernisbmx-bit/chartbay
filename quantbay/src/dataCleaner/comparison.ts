import { cleanText, isMissing, parseNumeric, validTaxId, type Profile, type Row, type Source } from './model';
import { request } from './storage';
import type { CleanerSession } from './session';
import type { TextSink } from './exporter';
export interface CompareOptions { currentKey: string; referenceKey: string; normalization: 'exact' | 'text' | 'tax-id'; jumpPercent: number }
interface KeyGroup { count: number; block: number; offset: number; row: number }
export type ComparisonKind = 'both' | 'modified' | 'new' | 'removed' | 'ambiguous' | 'missing-key';
export interface ComparisonRecord {
  kind: ComparisonKind; key: string | null; side: 'current' | 'reference'; row: number; referenceRow?: number;
  duplicate: boolean; countCurrent: number; countReference: number; cells: string[];
  changes: { column: string; before: string; after: string; jump: boolean }[];
}
export interface ColumnDrift {
  column: string; modified: number; abruptValues: number;
  beforeMean: number | null; afterMean: number | null; beforeMedian: number | null; afterMedian: number | null;
  meanPercentChange: number | null; nullPercentagePoints: number; abrupt: boolean;
}
export interface ComparisonReport {
  schemaVersion: 1; createdAt: string; current: Source; reference: Source; options: CompareOptions;
  currentHeaders: string[]; referenceHeaders: string[]; addedColumns: string[]; removedColumns: string[];
  matchedKeys: number; comparableKeys: number; ambiguousKeys: number; unchangedRows: number; modifiedRows: number;
  newRows: number; removedRows: number; currentDuplicateKeys: number; referenceDuplicateKeys: number;
  currentDuplicateRows: number; referenceDuplicateRows: number; currentMissingKeys: number; referenceMissingKeys: number;
  drift: ColumnDrift[]; preview: ComparisonRecord[]; records: number; blocks: number;
}
export function matchingKey(value: string, mode: CompareOptions['normalization']): string | null {
  if (isMissing(value)) return null;
  if (value.length > 4096) throw new Error('La clave de cruce supera 4096 caracteres. Elegí una columna identificadora.');
  if (mode === 'text') return cleanText(value).toLocaleLowerCase('es');
  if (mode === 'tax-id' && validTaxId(value)) return cleanText(value).replace(/-/g, '');
  return value;
}
async function indexKeys(session: CleanerSession, column: number, normalization: CompareOptions['normalization']): Promise<{ duplicates: number }> {
  await session.storage.clear('keys');
  let block = 0;
  for await (const rows of session.rows()) {
    const groups = new Map<string, KeyGroup>();
    rows.forEach((row, offset) => {
      const key = matchingKey(row.cells[column], normalization);
      if (key === null) return;
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, {count: 1, block, offset, row: row.n});
    });
    await session.storage.transaction('keys', 'readwrite', async store => {
      await Promise.all([...groups].map(async ([key, group]) => {
        const prior = await request<KeyGroup | undefined>(store.get(key));
        await request(store.put(prior ? {...prior, count: prior.count + group.count} : group, key));
      }));
    });
    block++;
  }
  let duplicates = 0;
  for await (const page of session.storage.pages<KeyGroup>('keys')) { session.check(); duplicates += page.filter(x => x.value.count > 1).length; }
  return {duplicates};
}
function percentDelta(before: number | null, after: number | null): number | null {
  return before === null || after === null || before === 0 ? null : (after - before) / Math.abs(before) * 100;
}
function abrupt(before: number | null, after: number | null, threshold: number): boolean {
  if (before === null || after === null) return false;
  return before === 0 ? after !== 0 : Math.abs(percentDelta(before, after)!) >= threshold && before !== after;
}
function previewRecord(record: ComparisonRecord): ComparisonRecord {
  const clip = (value: string) => value.length > 120 ? value.slice(0, 120) + '…' : value;
  return {...record, key: record.key === null ? null : clip(record.key), cells: record.cells.slice(0, 8).map(clip), changes: record.changes.slice(0, 8).map(c => ({...c, before: clip(c.before), after: clip(c.after)}))};
}
export async function compareSessions(current: CleanerSession, reference: CleanerSession, options: CompareOptions): Promise<ComparisonReport> {
  const currentIndex = current.headers.indexOf(options.currentKey), referenceIndex = reference.headers.indexOf(options.referenceKey);
  if (currentIndex < 0 || referenceIndex < 0) throw new Error('Elegí una clave existente en cada archivo.');
  if (!['exact','text','tax-id'].includes(options.normalization) || !Number.isFinite(options.jumpPercent) || options.jumpPercent < 0 || options.jumpPercent > 100000) throw new Error('Opciones de cruce inválidas.');
  if (!current.candidate || !reference.candidate) throw new Error('Perfilá ambos archivos antes del cruce.');
  const cp = current.candidate.profiles, rp = reference.candidate.profiles;
  const pairs = current.headers.flatMap((name, i) => {
    const j = reference.headers.indexOf(name);
    return j >= 0 && i !== currentIndex && j !== referenceIndex ? [{name, i, j}] : [];
  });
  const ai = await indexKeys(current, currentIndex, options.normalization);
  const bi = await indexKeys(reference, referenceIndex, options.normalization);
  const report: ComparisonReport = {
    schemaVersion: 1, createdAt: new Date().toISOString(), current: current.source, reference: reference.source, options: {...options},
    currentHeaders: current.headers, referenceHeaders: reference.headers,
    addedColumns: current.headers.filter((name, i) => i !== currentIndex && !reference.headers.includes(name)),
    removedColumns: reference.headers.filter((name, i) => i !== referenceIndex && !current.headers.includes(name)),
    matchedKeys: 0, comparableKeys: 0, ambiguousKeys: 0, unchangedRows: 0, modifiedRows: 0, newRows: 0, removedRows: 0,
    currentDuplicateKeys: ai.duplicates, referenceDuplicateKeys: bi.duplicates, currentDuplicateRows: 0, referenceDuplicateRows: 0,
    currentMissingKeys: 0, referenceMissingKeys: 0, preview: [], records: 0, blocks: 0,
    drift: pairs.map(({name, i, j}) => {
      const a = cp[i], b = rp[j];
      return {column: name, modified: 0, abruptValues: 0, beforeMean: b.mean, afterMean: a.mean,
        beforeMedian: b.advanced?.median ?? null, afterMedian: a.advanced?.median ?? null,
        meanPercentChange: percentDelta(b.mean, a.mean), nullPercentagePoints: (a.advanced?.nullPercent ?? 0) - (b.advanced?.nullPercent ?? 0),
        abrupt: abrupt(b.mean, a.mean, options.jumpPercent)};
    }),
  };
  for await (const page of current.storage.pages<KeyGroup>('keys')) {
    current.check();
    const matches = await reference.storage.getMany<KeyGroup>('keys', page.map(x => x.key));
    matches.forEach((match, i) => {
      if (!match) return;
      report.matchedKeys++;
      if (match.count === 1 && page[i].value.count === 1) report.comparableKeys++;
      else report.ambiguousKeys++;
    });
  }
  await current.storage.clear('comparison');
  let buffer: ComparisonRecord[] = [], bytes = 0;
  const previewCounts = new Map<string, number>();
  const flush = async () => {
    if (!buffer.length) return;
    current.check(); await current.storage.put('comparison', report.blocks++, buffer); buffer = []; bytes = 0;
  };
  const emit = async (record: ComparisonRecord) => {
    buffer.push(record); report.records++; bytes += JSON.stringify(record).length * 2;
    const normalPreview = (previewCounts.get(record.kind) ?? 0) < 20;
    const duplicatePreview = record.duplicate && (previewCounts.get('duplicates') ?? 0) < 20;
    if (normalPreview || duplicatePreview) report.preview.push(previewRecord(record));
    if (normalPreview) previewCounts.set(record.kind, (previewCounts.get(record.kind) ?? 0) + 1);
    if (duplicatePreview) previewCounts.set('duplicates', (previewCounts.get('duplicates') ?? 0) + 1);
    if (buffer.length >= 128 || bytes >= 512 * 1024) await flush();
  };
  const cache = new Map<number, Row[]>();
  const getReferenceRow = async (group: KeyGroup): Promise<Row> => {
    let rows = cache.get(group.block);
    if (!rows) {
      rows = await reference.storage.get<Row[]>('rows', group.block);
      cache.set(group.block, rows);
      if (cache.size > 2) cache.delete(cache.keys().next().value!);
    }
    return rows[group.offset];
  };
  for await (const rows of current.rows()) {
    const keys = rows.map(row => matchingKey(row.cells[currentIndex], options.normalization));
    const nonempty = keys.filter((key): key is string => key !== null);
    const [ag, bg] = await Promise.all([current.storage.getMany<KeyGroup>('keys', nonempty), reference.storage.getMany<KeyGroup>('keys', nonempty)]);
    let k = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], key = keys[i];
      const a = key === null ? undefined : ag[k], b = key === null ? undefined : bg[k++];
      const base: ComparisonRecord = {kind: 'both', key, side: 'current', row: row.n, duplicate: (a?.count ?? 0) > 1,
        countCurrent: a?.count ?? 0, countReference: b?.count ?? 0, cells: row.cells, changes: []};
      if (base.duplicate) report.currentDuplicateRows++;
      if (key === null) { report.currentMissingKeys++; await emit({...base, kind: 'missing-key'}); }
      else if (!b) { report.newRows++; await emit({...base, kind: 'new'}); }
      else if (a!.count > 1 || b.count > 1) await emit({...base, kind: 'ambiguous'});
      else {
        const previous = await getReferenceRow(b);
        const changes: ComparisonRecord['changes'] = [];
        pairs.forEach(({name, i, j}, index) => {
          if (row.cells[i] === previous.cells[j]) return;
          const jump = cp[i].type === 'número' && rp[j].type === 'número' && abrupt(parseNumeric(previous.cells[j], rp[j].decimal), parseNumeric(row.cells[i], cp[i].decimal), options.jumpPercent);
          changes.push({column: name, before: previous.cells[j], after: row.cells[i], jump});
          report.drift[index].modified++;
          if (jump) report.drift[index].abruptValues++;
        });
        if (changes.length) report.modifiedRows++; else report.unchangedRows++;
        await emit({...base, kind: changes.length ? 'modified' : 'both', referenceRow: previous.n, changes});
      }
    }
  }
  cache.clear();
  for await (const rows of reference.rows()) {
    const keys = rows.map(row => matchingKey(row.cells[referenceIndex], options.normalization));
    const nonempty = keys.filter((key): key is string => key !== null);
    const [ag, bg] = await Promise.all([current.storage.getMany<KeyGroup>('keys', nonempty), reference.storage.getMany<KeyGroup>('keys', nonempty)]);
    let k = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], key = keys[i];
      const a = key === null ? undefined : ag[k], b = key === null ? undefined : bg[k++];
      if ((b?.count ?? 0) > 1) report.referenceDuplicateRows++;
      const base: ComparisonRecord = {kind: 'both', key, side: 'reference', row: row.n, duplicate: (b?.count ?? 0) > 1,
        countCurrent: a?.count ?? 0, countReference: b?.count ?? 0, cells: row.cells, changes: []};
      if (key === null) { report.referenceMissingKeys++; await emit({...base, kind: 'missing-key'}); }
      else if (!a) { report.removedRows++; await emit({...base, kind: 'removed'}); }
      else if (a.count > 1 || b!.count > 1) await emit({...base, kind: 'ambiguous'});
    }
  }
  await flush();
  return report;
}
export async function exportComparison(session: CleanerSession, report: ComparisonReport, sink: TextSink): Promise<void> {
  try {
    const {preview, ...summary} = report;
    await sink.write(JSON.stringify({...summary, semantics: 'Cruce de los archivos originales. Nuevas: solo actual; eliminadas: solo referencia. Claves vacías no se cruzan. Claves repetidas no se emparejan arbitrariamente. Campos comparados literalmente por encabezados comunes. Cuantiles exactos; desvío estándar muestral.'}).slice(0, -1) + ',"details":[');
    let first = true;
    for (let block = 0; block < report.blocks; block++) {
      session.check();
      const records = await session.storage.get<ComparisonRecord[]>('comparison', block);
      for (const record of records) { await sink.write((first ? '' : ',') + JSON.stringify(record)); first = false; }
    }
    await sink.write(']}'); session.check(); await sink.close();
  } catch (error) { await sink.abort().catch(() => undefined); throw error; }
}
