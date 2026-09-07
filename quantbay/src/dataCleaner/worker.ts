import { listSheets, type ImportOptions } from './importers';
import { CleanerStorage, deleteStorage } from './storage';
import { CleanerSession } from './session';
import { exportSession, exportQuality } from './exporter';
import { DEFAULT_RULES, type Rules } from './model';
import { compareSessions, exportComparison, type CompareOptions, type ComparisonReport } from './comparison';
export type Request = { id: number } & (
  | { kind: 'sheets'; file: File }
  | { kind: 'import'; file: File; database: string; options: ImportOptions; rules: Rules }
  | { kind: 'review'; rules: Rules }
  | { kind: 'reference'; file: File; database: string; options: ImportOptions }
  | { kind: 'compare'; options: CompareOptions }
  | { kind: 'apply' | 'undo' | 'cancel' }
  | { kind: 'export'; format: 'csv' | 'audit' | 'quality' | 'comparison'; safeForExcel: boolean; target?: FileSystemFileHandle; directory: string }
);
const ctx = self as unknown as { onmessage: (e: MessageEvent<Request>) => void; postMessage(value: unknown): void };
let reference: CleanerSession | null = null, comparison: ComparisonReport | null = null;
let session: CleanerSession | null = null, cancelled = false, busy = false;
ctx.onmessage = async ({ data }) => {
  if (data.kind === 'cancel') { cancelled = true; return; }
  if (busy) { ctx.postMessage({ id: data.id, kind: 'error', message: 'Hay una operación en curso.' }); return; }
  busy = true; cancelled = false;
  let lastProgress = 0;
  const progress = (stage: string, fraction: number) => {
    const now = Date.now();
    if (now - lastProgress > 120 || fraction === 1) { ctx.postMessage({ id: data.id, kind: 'progress', stage, fraction }); lastProgress = now; }
  };
  const check = () => { if (cancelled) throw new Error('Operación cancelada.'); };
  try {
    let result: unknown;
    if (data.kind === 'sheets') result = await listSheets(data.file);
    else if (data.kind === 'import') {
      session?.storage.close(); reference?.storage.close(); reference = null; comparison = null;
      session = new CleanerSession(await CleanerStorage.open(data.database), check, progress);
      await session.import(data.file, data.options);
      result = { review: await session.review(data.rules), source: session.source };
    } else {
      if (!session) throw new Error('Primero importá un archivo.');
      // Refresh callbacks for this request's id; the storage and original rows are unchanged.
      session.check = check;
      session.progress = (stage, fraction) => progress(data.kind === 'export' ? 'Exportando' : stage, fraction);
      if (data.kind === 'reference') {
        comparison = null; reference?.storage.close(); reference = null;
        await deleteStorage(data.database);
        const next = new CleanerSession(await CleanerStorage.open(data.database), check, (stage, n) => progress('Referencia · ' + stage, n));
        try {
          await next.import(data.file, data.options);
          const review = await next.review({...DEFAULT_RULES, trimText: false, normalizeIdentifiers: false});
          reference = next; result = {source: next.source, headers: next.headers, profiles: review.profiles};
        } catch (error) { next.storage.close(); await deleteStorage(data.database); throw error; }
      }
      if (data.kind === 'compare') {
        if (!reference) throw new Error('Importá el archivo de referencia antes de cruzar.');
        comparison = null;
        reference.check = check; reference.progress = (_stage, n) => progress('Cruzando referencia', n);
        session.progress = (_stage, n) => progress('Cruzando archivo actual', n);
        comparison = await compareSessions(session, reference, data.options); result = comparison;
      }
      if (data.kind === 'review') { comparison = null; }
      if (data.kind === 'review') result = { review: await session.review(data.rules), source: session.source };
      if (data.kind === 'apply') result = { review: session.apply(), undo: session.history.length };
      if (data.kind === 'undo') comparison = null;
      if (data.kind === 'undo') result = { review: await session.undo(), undo: session.history.length };
      if (data.kind === 'export') {
        if (data.format === 'comparison' && !comparison) throw new Error('Generá el cruce antes de exportar.');
        if (data.format === 'quality' && !session.candidate) throw new Error('Generá una vista previa.');
        if ((data.format === 'csv' || data.format === 'audit') && !session.applied) throw new Error('Aplicá los cambios antes de exportar.');
        let target = data.target;
        if (!target) {
          if (!navigator.storage?.getDirectory) throw new Error('Este navegador no permite exportar por bloques. Usá Chrome o Edge actualizado.');
          const root = await navigator.storage.getDirectory();
          const directory = await root.getDirectoryHandle(data.directory, { create: true });
          target = await directory.getFileHandle(crypto.randomUUID() + (data.format === 'csv' ? '.csv' : '.json'), { create: true });
        }
        const stream = await target.createWritable();
        if (data.format === 'comparison') await exportComparison(session, comparison!, stream);
        else if (data.format === 'quality') await exportQuality(session, stream);
        else await exportSession(session, data.format, stream, data.safeForExcel);
        result = data.target ? { saved: true } : { file: await target.getFile() };
      }
    }
    ctx.postMessage({ id: data.id, kind: 'done', result });
  } catch (error) {
    const e = error as Error;
    const message = e.name === 'QuotaExceededError' ? 'No hay espacio temporal suficiente. Liberá espacio en disco y volvé a importar.'
      : e instanceof TypeError && /encoded|encoding|decode/i.test(e.message) ? 'No se pudo leer el texto. Probá la codificación Windows-1252 para CSV de Excel.' : e.message;
    ctx.postMessage({ id: data.id, kind: 'error', message });
  } finally { busy = false; }
};
