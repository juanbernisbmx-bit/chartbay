import Papa from 'papaparse';
import { ZipReader, BlobReader, TextWriter, configure, type Entry } from '@zip.js/zip.js';
import { SaxesParser } from 'saxes';
import { CleanerStorage, MAX_COLUMNS, MAX_ROW_BYTES } from './storage';
configure({ useWebWorkers: false, chunkSize: 64 * 1024 });
export type EmitRow = (cells: string[], row: number) => Promise<void>;
export interface ImportOptions { delimiter?: string; encoding?: string; sheet?: string }
const CHUNK = 64 * 1024;

/** RFC4180 state survives byte chunks, escaped quotes and multiline records. */
export async function importCsv(file: Blob, options: ImportOptions, emit: EmitRow, progress: (n: number) => void): Promise<void> {
  const prefix = new Uint8Array(await file.slice(0, CHUNK).arrayBuffer());
  const encoding = options.encoding || (prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf-16le'
    : prefix[0] === 0xfe && prefix[1] === 0xff ? 'utf-16be' : 'utf-8');
  const decoder = new TextDecoder(encoding, { fatal: true });
  const sample = new TextDecoder(encoding).decode(prefix);
  const delimiter = options.delimiter || Papa.parse(sample, { preview: 20 }).meta.delimiter || ',';
  let field = '', row: string[] = [], quoted = false, afterQuote = false, cr = false, rowSize = 0, rowNumber = 1, started = false;
  const endField = () => { row.push(field); field = ''; if (row.length > MAX_COLUMNS) throw new Error(`Máximo ${MAX_COLUMNS} columnas.`); };
  const endRow = async () => { endField(); await emit(row, rowNumber++); row = []; rowSize = 0; started = false; };
  const consume = async (text: string) => {
    for (const ch of text) {
      if (cr) { cr = false; if (ch === '\n') continue; }
      if (++rowSize * 2 > MAX_ROW_BYTES) throw new Error(`La fila ${rowNumber} supera el límite de 4 MiB por registro.`);
      started = true;
      if (quoted) {
        if (ch === '"') { quoted = false; afterQuote = true; } else field += ch;
      } else if (afterQuote) {
        if (ch === '"') { field += '"'; quoted = true; afterQuote = false; }
        else if (ch === delimiter) { endField(); afterQuote = false; }
        else if (ch === '\r' || ch === '\n') { await endRow(); afterQuote = false; cr = ch === '\r'; }
        else throw new Error(`CSV mal formado en fila ${rowNumber}: contenido después de comillas.`);
      } else if (ch === '"') {
        if (field) throw new Error(`CSV mal formado en fila ${rowNumber}: comilla dentro de un campo sin comillas.`);
        quoted = true;
      } else if (ch === delimiter) endField();
      else if (ch === '\r' || ch === '\n') { await endRow(); cr = ch === '\r'; }
      else field += ch;
    }
  };
  for (let offset = 0; offset < file.size; offset += CHUNK) {
    await consume(decoder.decode(await file.slice(offset, offset + CHUNK).arrayBuffer(), { stream: true }));
    progress(Math.min(1, (offset + CHUNK) / file.size));
  }
  await consume(decoder.decode());
  if (quoted) throw new Error(`CSV mal formado: comillas sin cerrar en fila ${rowNumber}.`);
  if (started || row.length || field) await endRow();
}

function parser(): SaxesParser<{ xmlns: false }> {
  const p = new SaxesParser({ xmlns: false });
  p.on('doctype', () => { throw new Error('XML con DTD no admitido.'); });
  return p;
}
const local = (name: string) => name.split(':').pop()!;
const attr = (attrs: Record<string, string>, key: string) => attrs[key] ?? '';
async function xmlText(entry: Entry | undefined): Promise<string> {
  if (!entry || entry.directory || !entry.getData) throw new Error('El libro Excel está incompleto.');
  if (entry.uncompressedSize > 4 * 1024 * 1024) throw new Error('Metadatos Excel demasiado grandes (máximo 4 MiB).');
  return entry.getData(new TextWriter(), { checkSignature: true });
}
export interface Sheet { name: string; path: string }
async function bookInfo(entries: Entry[]): Promise<{ sheets: Sheet[]; date1904: boolean }> {
  const rels = new Map<string, string>();
  const rp = parser();
  rp.on('opentag', tag => {
    if (local(tag.name) === 'Relationship') {
      const a = tag.attributes;
      if (a.TargetMode === 'External') return;
      const target = attr(a, 'Target');
      const path = new URL(target, 'https://local/xl/workbook.xml').pathname.slice(1);
      rels.set(attr(a, 'Id'), path);
    }
  });
  rp.write(await xmlText(entries.find(e => e.filename === 'xl/_rels/workbook.xml.rels'))).close();
  const sheets: Sheet[] = []; let date1904 = false;
  const wp = parser();
  wp.on('opentag', tag => {
    if (local(tag.name) === 'workbookPr') date1904 = ['1', 'true'].includes(attr(tag.attributes, 'date1904'));
    if (local(tag.name) === 'sheet') {
      const path = rels.get(attr(tag.attributes, 'r:id'));
      if (path && entries.some(e => e.filename === path)) sheets.push({ name: attr(tag.attributes, 'name'), path });
    }
  });
  wp.write(await xmlText(entries.find(e => e.filename === 'xl/workbook.xml'))).close();
  if (!sheets.length) throw new Error('El libro no contiene hojas legibles.');
  return { sheets, date1904 };
}
export async function listSheets(file: Blob): Promise<Sheet[]> {
  const zip = new ZipReader(new BlobReader(file));
  try { return (await bookInfo(await zip.getEntries())).sheets; } finally { await zip.close(); }
}
async function streamXml(entry: Entry, p: SaxesParser<{ xmlns: false }>, drain: () => Promise<void>, progress?: (n: number) => void): Promise<void> {
  if (entry.directory || !entry.getData) throw new Error('Entrada Excel inválida.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  await entry.getData(new WritableStream<Uint8Array>({
    async write(bytes) {
      // zip output can exceed its configured compressed input chunk: split before SAX.
      for (let i = 0; i < bytes.length; i += CHUNK) {
        p.write(decoder.decode(bytes.subarray(i, i + CHUNK), { stream: true }));
        await drain();
      }
    },
    async close() { p.write(decoder.decode()).close(); await drain(); },
  }), { checkSignature: true, onprogress: (current, total) => progress?.(total ? current / total : 0) });
}
export async function importXlsx(file: Blob, storage: CleanerStorage, options: ImportOptions, emit: EmitRow, progress: (n: number) => void): Promise<string[]> {
  const zip = new ZipReader(new BlobReader(file));
  try {
    const entries = await zip.getEntries();
    const info = await bookInfo(entries);
    const sheet = info.sheets.find(s => s.name === options.sheet) ?? (options.sheet ? undefined : info.sheets[0]);
    if (!sheet) throw new Error('No se encontró la hoja seleccionada.');
    const shared = entries.find(e => e.filename === 'xl/sharedStrings.xml');
    if (shared) {
      let inside = false, text = '', index = 0, phonetic = false;
      let pending: [number, string][] = [];
      const sp = parser();
      sp.on('opentag', tag => {
        const n = local(tag.name);
        if (n === 'si') text = '';
        if (n === 'rPh') phonetic = true;
        if (n === 't' && !phonetic) inside = true;
      });
      sp.on('text', t => { if (inside) { text += t; if (text.length * 2 > MAX_ROW_BYTES) throw new Error('Texto Excel demasiado grande.'); } });
      sp.on('closetag', tag => {
        const n = local(tag.name);
        if (n === 't') inside = false;
        if (n === 'rPh') phonetic = false;
        if (n === 'si') pending.push([index++, text]);
      });
      await streamXml(shared, sp, async () => { if (pending.length) { const batch = pending; pending = []; await storage.strings(batch); } });
    }
    const dateStyles = new Set<number>();
    const styles = entries.find(e => e.filename === 'xl/styles.xml');
    if (styles) {
      const formats = new Map<number, string>(); let inXfs = false, index = 0;
      const sp = parser();
      sp.on('opentag', tag => {
        const n = local(tag.name);
        if (n === 'numFmt') formats.set(Number(tag.attributes.numFmtId), attr(tag.attributes, 'formatCode'));
        if (n === 'cellXfs') inXfs = true;
        if (n === 'xf' && inXfs) {
          const id = Number(tag.attributes.numFmtId);
          const format = (formats.get(id) ?? '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
          if ((id >= 14 && id <= 22) || /[yd]/i.test(format)) dateStyles.add(index);
          index++;
        }
      });
      sp.on('closetag', tag => { if (local(tag.name) === 'cellXfs') inXfs = false; });
      sp.write(await xmlText(styles)).close();
    }
    type Cell = { index: number; type: string; style: number; value: string; formula: boolean };
    let row: Cell[] = [], rowNo = 0, cell: Cell | null = null, capture = false, rowChars = 0;
    let pending: { cells: Cell[]; n: number }[] = [], formulas = 0, noCache = 0;
    const p = parser();
    p.on('opentag', tag => {
      const n = local(tag.name);
      if (n === 'row') { row = []; rowNo = Number(tag.attributes.r) || rowNo + 1; rowChars = 0; }
      if (n === 'c') {
        const ref = attr(tag.attributes, 'r').match(/^[A-Z]+/)?.[0];
        const index = ref ? [...ref].reduce((v, c) => v * 26 + c.charCodeAt(0) - 64, 0) - 1 : (row[row.length - 1]?.index ?? -1) + 1;
        if (index >= MAX_COLUMNS) throw new Error(`Máximo ${MAX_COLUMNS} columnas.`);
        cell = { index, type: attr(tag.attributes, 't'), style: Number(tag.attributes.s ?? -1), value: '', formula: false };
      }
      if (n === 'v' || n === 't') capture = true;
      if (n === 'f' && cell) cell.formula = true;
    });
    p.on('text', text => {
      if (capture && cell) { cell.value += text; rowChars += text.length; }
      if (rowChars * 2 > MAX_ROW_BYTES) throw new Error(`La fila Excel ${rowNo} supera 4 MiB.`);
    });
    p.on('closetag', tag => {
      const n = local(tag.name);
      if (n === 'v' || n === 't') capture = false;
      if (n === 'c' && cell) { row.push(cell); cell = null; }
      if (n === 'row') pending.push({ cells: row, n: rowNo });
    });
    await streamXml(entries.find(e => e.filename === sheet.path)!, p, async () => {
      const batch = pending; pending = [];
      for (const r of batch) {
        const cells: string[] = [];
        for (const c of r.cells) {
          let value = c.value;
          if (c.type === 's') {
            const sharedValue = await storage.get<string | undefined>('strings', Number(value));
            if (sharedValue === undefined) throw new Error(`Referencia de texto inválida en fila ${r.n}.`);
            value = sharedValue;
          } else if (c.type === 'b') value = value === '1' ? 'true' : 'false';
          else if (value && dateStyles.has(c.style) && (!c.type || c.type === 'n')) {
            const serial = Number(value);
            if (Number.isFinite(serial) && serial >= 0 && serial < 2958466) {
              // Excel's fictitious 1900-02-29 is retained instead of silently becoming another date.
              if (!info.date1904 && Math.floor(serial) === 60) value = '1900-02-29';
              else {
                const days = info.date1904 ? serial : serial - (serial >= 60 ? 1 : 0);
                const date = new Date((info.date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)) + days * 86400000);
                value = Number.isInteger(serial) ? date.toISOString().slice(0, 10) : date.toISOString();
              }
            }
          }
          if (c.formula) { formulas++; if (!c.value) noCache++; }
          cells[c.index] = value;
        }
        await emit(Array.from({ length: cells.length }, (_, i) => cells[i] ?? ''), r.n);
      }
    }, progress);
    return [
      'Excel: se importan valores de la hoja seleccionada; no se conservan formato, macros ni fórmulas.',
      ...(formulas ? [`${formulas} fórmulas: se usaron sus valores guardados; ${noCache} no tienen resultado guardado y quedan vacías. Recalculá y guardá el libro en Excel si necesitás actualizarlos.`] : []),
    ];
  } finally { await zip.close(); }
}
