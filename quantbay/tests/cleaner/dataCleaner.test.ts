// @vitest-environment node
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach } from 'vitest';
import { ZipWriter, BlobWriter, TextReader } from '@zip.js/zip.js';
import { CleanerStorage, deleteStorage } from '../../src/dataCleaner/storage';
import { CleanerSession } from '../../src/dataCleaner/session';
import { importCsv, listSheets } from '../../src/dataCleaner/importers';
import { DEFAULT_RULES, csvLine, validDate, validTaxId, parseNumeric } from '../../src/dataCleaner/model';
import { exportSession } from '../../src/dataCleaner/exporter';
import { putHandoff, takeHandoff } from '../../src/services/datasetHandoff';
const sessions: CleanerSession[] = [];
async function session(text: string, rules = DEFAULT_RULES): Promise<CleanerSession> {
  const s = new CleanerSession(await CleanerStorage.open('test-' + crypto.randomUUID()), () => {}, () => {});
  sessions.push(s);
  await s.import(new File([text], 'datos.csv'), {});
  await s.review(structuredClone(rules));
  return s;
}
afterEach(async () => { for (const s of sessions.splice(0)) { const name = s.storage.db.name; s.storage.close(); await deleteStorage(name); } });
async function exported(s: CleanerSession, kind: 'csv' | 'audit', safe = false): Promise<string> {
  let text = '';
  await exportSession(s, kind, { write: async v => { text += v; }, close: async () => {}, abort: async () => {} }, safe);
  return text;
}
const tax = (body: string) => { const sum = [5,4,3,2,7,6,5,4,3,2].reduce((s,w,i) => s+w*Number(body[i]),0); return body + ((11-sum%11)%11); };
describe('Data Cleaner: identifiers and conservative typing', () => {
  it('validates checksum and format without stripping arbitrary characters', () => {
    const id = tax('2012345678');
    expect(validTaxId(id)).toBe(true);
    expect(validTaxId(`${id.slice(0,2)}-${id.slice(2,10)}-${id[10]}`)).toBe(true);
    expect(validTaxId(id.slice(0,10) + ((Number(id[10])+1)%10))).toBe(false);
    expect(validTaxId('CUIT ' + id)).toBe(false);
    expect(validTaxId('00000000000')).toBe(false);
  });
  it('rejects impossible dates and malformed numeric grouping', () => {
    expect(validDate('29/02/2024')).toBe(true);
    expect(validDate('29/02/2023')).toBe(false);
    expect(validDate('31/04/2024')).toBe(false);
    expect(parseNumeric('1.234,50', ',')).toBe(1234.5);
    expect(parseNumeric('1,5', '.')).toBeNull();
    expect(parseNumeric('1e999', '.')).toBeNull();
  });
  it('preserves leading zeros and detects invalid values beyond the sample', async () => {
    const s = await session('codigo,monto,fecha\n' + Array.from({length: 210}, (_,i) => `00${i},${i === 209 ? 'roto' : i},${i === 209 ? '31/02/2024' : '29/02/2024'}`).join('\n'));
    expect(s.candidate!.profiles.map(p => p.type)).toEqual(['identificador','número','fecha']);
    expect(s.candidate!.profiles[1].invalid).toBe(1);
    expect(s.candidate!.profiles[1].invalidExamples).toEqual([{ row: 211, value: 'roto' }]);
    expect(s.candidate!.profiles[2].invalid).toBe(1);
    s.apply(); expect(await exported(s,'csv')).toContain('000,0,29/02/2024');
  });
});
describe('CSV streaming', () => {
  it('preserves multiline fields, escaped quotes, UTF8 boundaries and CRLF', async () => {
    const value = 'a'.repeat(65520) + 'ñ\n"hola"';
    const text = 'nombre;texto\r\nJuan;"' + value.replace(/"/g,'""') + '"\r\n';
    const rows: string[][] = [];
    await importCsv(new Blob([text]), { delimiter: ';' }, async cells => { rows.push(cells); }, () => {});
    expect(rows).toEqual([['nombre','texto'],['Juan',value]]);
  });
  it('rejects unterminated quotes and ragged rows without silently dropping cells', async () => {
    await expect(importCsv(new Blob(['a,b\n1,"oops']), {}, async () => {}, () => {})).rejects.toThrow('comillas');
    await expect(session('a,b\n1,2,3')).rejects.toThrow('3 campos');
  });
  it('supports Excel Windows-1252 and UTF16 BOMs', async () => {
    const rows: string[][] = [];
    await importCsv(new Blob([new Uint8Array([110,111,109,98,114,101,10,74,111,115,233])]), {encoding:'windows-1252'}, async cells => { rows.push(cells); }, () => {});
    expect(rows[1][0]).toBe('José');
    const data = new Uint8Array([255,254,97,0,10,0,241,0]);
    const utf: string[][] = [];
    await importCsv(new Blob([data]), {}, async cells => { utf.push(cells); }, () => {});
    expect(utf).toEqual([['a'],['ñ']]);
  });
});
describe('Preview, apply, undo and audit', () => {
  it('detects global duplicates across blocks; preview never mutates original', async () => {
    const input = 'nombre,valor\n' + Array.from({length:600},(_,i) => ` Nombre ${i} ,${i}`).join('\n') + '\n Nombre 0 ,0';
    const s = await session(input, {...DEFAULT_RULES, dropDuplicates:true});
    expect(s.blocks).toBeGreaterThan(1);
    expect(s.candidate!.duplicates).toBe(1);
    expect(s.candidate!.removedRows).toBe(1);
    expect(s.candidate!.changedCells).toBe(600);
    expect(s.candidate!.preview.length).toBe(100);
    expect(s.applied).toBeNull();
    expect((await s.storage.get<{cells:string[]}[]>('rows',0))[0].cells[0]).toBe(' Nombre 0 ');
    await expect(exported(s,'csv')).rejects.toThrow('Aplicá');
    s.apply();
    const csv = await exported(s,'csv'); expect(csv.split('\r\n').length).toBe(602);
    const audit = JSON.parse(await exported(s,'audit'));
    expect(audit.changes).toHaveLength(601);
    expect(audit.changes[600].reason).toBe('Duplicada de la fila 2');
    await s.undo(); expect(s.applied).toBeNull();
  });
  it('shows renamed headers before applying and includes them in the audit', async () => {
    const s = await session('a,a,\n1,2,3');
    expect(s.candidate!.preview.map(c => c.after)).toEqual(['a (2)', 'Columna 3']);
    s.apply();
    const report = JSON.parse(await exported(s, 'audit'));
    expect(report.changes).toHaveLength(2);
    expect(report.source.originalHeaders).toEqual(['a','a','']);
    await s.undo();
    await s.review({...DEFAULT_RULES, normalizeHeaders:false}); s.apply();
    expect(await exported(s,'csv')).toBe('\uFEFFa,a,\r\n1,2,3\r\n');
  });
  it('undo restores prior rules and output, including dropped rows', async () => {
    const s = await session('a,b\n Ana ,1\n Ana ,1\nLuis,NA');
    s.apply(); const first = await exported(s,'csv');
    await s.review({...DEFAULT_RULES, missing:'drop', dropDuplicates:true}); s.apply();
    expect(s.applied!.rowsOut).toBe(1);
    await s.undo(); expect(await exported(s,'csv')).toBe(first);
    expect(s.history).toHaveLength(1);
    expect(s.events.map(e => e.action)).toEqual(['aplicar','aplicar','deshacer']);
  });
  it('audits formula escaping and keeps data unescaped when requested', async () => {
    const s = await session('nombre,valor\n=2+2,-3'); s.apply();
    expect(await exported(s,'csv',true)).toContain("'=2+2,'-3");
    expect(await exported(s,'csv',false)).toContain('=2+2,-3');
    const report = JSON.parse(await exported(s,'audit',true)); expect(report.changes).toHaveLength(0);
    expect(report.lastCsvExport.safeForExcel).toBe(false);
    await exported(s,'csv',true);
    expect(JSON.parse(await exported(s,'audit',false)).changes).toHaveLength(2);
    expect(csvLine(['a"b','c\nd'])).toBe('"a""b","c\nd"\r\n');
  });
  it('aborts an incomplete export on quota/write errors', async () => {
    const s = await session('a\n1'); s.apply(); let aborted = false;
    await expect(exportSession(s,'csv',{write:async()=>{throw new Error('quota');},close:async()=>{},abort:async()=>{aborted=true;}},false)).rejects.toThrow('quota');
    expect(aborted).toBe(true);
  });
  it('bounds samples and previews while counting unique values exactly on disk', async () => {
    const s = await session('a\n' + Array.from({length:2000},(_,i) => ` valor ${i}`).join('\n'));
    expect(s.sample.length).toBeLessThanOrEqual(200);
    expect(s.candidate!.profiles[0].unique).toBe(2000);
    expect(s.candidate!.profiles[0].uniqueCapped).toBe(false);
    expect(s.candidate!.preview.length).toBe(100);
  });
});
async function workbook(): Promise<File> {
  const zip = new ZipWriter(new BlobWriter(), {useWebWorkers:false});
  const files: Record<string,string> = {
    'xl/workbook.xml':'<workbook xmlns:r="urn:r"><workbookPr date1904="0"/><sheets><sheet name="Datos" r:id="rId1"/><sheet name="Otra" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml':'<sst><si><t>nombre</t></si><si><r><t> Ana</t></r><r><t> Pérez </t></r></si></sst>',
    'xl/styles.xml':'<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>fecha</t></is></c><c r="C1" t="inlineStr"><is><t>total</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" s="1"><v>45292</v></c><c r="C2"><f>1+1</f><v>2</v></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>Luis</t></is></c><c r="C5"><f>1+2</f></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>codigo</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>00123</t></is></c></row></sheetData></worksheet>',
  };
  for (const [name,xml] of Object.entries(files)) await zip.add(name,new TextReader(xml));
  return new File([await zip.close()],'libro.xlsx');
}
describe('Excel streaming', () => {
  it('reads sheets, disk shared strings, sparse cells, dates and cached formulas', async () => {
    const file = await workbook();
    expect((await listSheets(file)).map(s=>s.name)).toEqual(['Datos','Otra']);
    const s = new CleanerSession(await CleanerStorage.open('xlsx-' + crypto.randomUUID()),()=>{},()=>{}); sessions.push(s);
    await s.import(file,{sheet:'Datos'});
    const rows = await s.storage.get<{n:number;cells:string[]}[]>('rows',0);
    expect(rows).toEqual([{n:2,cells:[' Ana Pérez ','2024-01-01','2']},{n:5,cells:['Luis','','']}]);
    expect(s.source.warnings.join(' ')).toContain('1 no tienen resultado');
    await s.review(DEFAULT_RULES); s.apply(); expect(await exported(s,'csv')).toContain('Ana Pérez,2024-01-01,2');
  });
  it('budgets sparse Excel rows after padding instead of undercounting their memory', async () => {
    const zip = new ZipWriter(new BlobWriter(), {useWebWorkers:false});
    await zip.add('xl/workbook.xml', new TextReader('<workbook xmlns:r="urn:r"><sheets><sheet name="Wide" r:id="r1"/></sheets></workbook>'));
    await zip.add('xl/_rels/workbook.xml.rels', new TextReader('<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>'));
    const xml = '<worksheet><sheetData><row r="1"><c r="ALL1" t="inlineStr"><is><t>last</t></is></c></row>' + Array.from({length:300},(_,i)=>`<row r="${i+2}"/>`).join('') + '</sheetData></worksheet>';
    await zip.add('xl/worksheets/sheet1.xml', new TextReader(xml));
    const file = new File([await zip.close()], 'wide.xlsx');
    const s = new CleanerSession(await CleanerStorage.open('wide-' + crypto.randomUUID()),()=>{},()=>{}); sessions.push(s);
    await s.import(file, {sheet:'Wide'});
    expect(s.headers).toHaveLength(1000);
    expect(s.sample.reduce((n,r)=>n+r.cells.reduce((sum,c)=>sum+c.length*2+16,0),0)).toBeLessThanOrEqual(2*1024*1024);
    expect((await s.storage.get<unknown[]>('rows',0)).length).toBeLessThanOrEqual(33);
    expect(s.blocks).toBeGreaterThan(8);
  });
  it('imports only the selected sheet and preserves text identifiers', async () => {
    const s = new CleanerSession(await CleanerStorage.open('xlsx-' + crypto.randomUUID()),()=>{},()=>{}); sessions.push(s);
    await s.import(await workbook(),{sheet:'Otra'});
    await s.review(DEFAULT_RULES); s.apply();
    expect(await exported(s,'csv')).toContain('00123');
    expect(s.candidate!.rowsIn).toBe(1);
  });
});

describe('Disk Blob handoff', () => {
  it('commits a Blob before navigation and consumes it once', async () => {
    await putHandoff('limpio.csv', new Blob(['a,b\r\n1,2\r\n'], {type:'text/csv'}));
    const file = await takeHandoff();
    expect(file?.name).toBe('limpio.csv');
    expect(await file?.text()).toBe('a,b\r\n1,2\r\n');
    expect(await takeHandoff()).toBeNull();
  });
});
