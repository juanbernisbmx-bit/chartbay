/**
 * Traspaso del CSV limpio entre la sección del limpiador y la de econometría.
 *
 * Son dos páginas distintas, así que no hay estado compartido: lo que cruza es
 * el archivo ya limpio, guardado en IndexedDB. Se eligió IndexedDB y no
 * sessionStorage porque este último guarda strings y tope alrededor de 5 MB —
 * justo el tamaño a partir del cual el traspaso empieza a tener sentido.
 *
 * Cruza el CSV y no las columnas tipadas a propósito. Los Float64Array podrían
 * serializarse, pero entonces econometría tendría que confiar en que vienen
 * bien formados; volviéndolos a pasar por el limpiador se reusa exactamente el
 * mismo camino de validación que un archivo recién subido, y limpiar algo ya
 * limpio es rápido e idempotente.
 */

const DB_NAME = 'chartbay';
const STORE = 'handoff';
const KEY = 'dataset';

export interface DatabaseHandoff {
  source: 'database';
  mode: 'regression' | 'timeseries';
  yName: string;
  xNames: string[];
  releaseId: string;
  preparedAt: string;
  rows: number;
  start: string;
  end: string;
  excludedMonths: string[];
  incompleteMonths: string[];
  series: Array<{
    id: string; name: string; column: string; unit: string; transform: string; lag: number;
    source: string; sourceUrl: string; originalUrl: string | null; sha256: string | null;
    retrievedAt: string | null; publishedAt: string | null; normalizationNotes: string[];
    license?: string | null; licenseUrl?: string | null; attribution?: string | null;
    releaseId?: string;
  }>;
}

interface HandoffRecord {
  name: string;
  csv: Blob;
  savedAt: number;
  metadata?: DatabaseHandoff;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir IndexedDB.'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      // A successful put is not a committed transaction. Navigation must wait
      // for commit, especially when the source Blob is backed by an OPFS file.
      transaction.oncomplete = () => { db.close(); resolve(request.result); };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error ?? request.error ?? new Error('Falló IndexedDB.'));
      };
    } catch (error) { db.close(); reject(error); }
  }));
}

/** Deja el CSV limpio listo para que lo levante la otra sección. */
export async function putHandoff(name: string, csv: string | Blob, metadata?: DatabaseHandoff): Promise<void> {
  const record: HandoffRecord = {
    name,
    csv: new Blob([csv], { type: 'text/csv' }),
    savedAt: Date.now(),
    metadata,
  };
  await tx('readwrite', store => store.put(record, KEY));
}

/**
 * Levanta el dataset pendiente, si hay, y lo borra.
 *
 * Se consume de una sola vez: si quedara, recargar econometría volvería a
 * cargar un archivo que el usuario ya no está esperando.
 */
export async function takeHandoff(): Promise<File | null> {
  return (await takeHandoffDataset())?.file ?? null;
}

export async function takeHandoffDataset(): Promise<{ file: File; metadata?: DatabaseHandoff } | null> {
  let record: HandoffRecord | undefined;
  try {
    record = await tx<HandoffRecord | undefined>('readonly', store => store.get(KEY));
  } catch {
    return null;  // navegación privada, cuota, permisos: no es motivo para romper
  }
  if (!record) return null;
  await tx('readwrite', store => store.delete(KEY)).catch(() => undefined);
  return { file: new File([record.csv], record.name, { type: 'text/csv' }), metadata: record.metadata };
}

export async function hasHandoff(): Promise<boolean> {
  try {
    return (await tx<HandoffRecord | undefined>('readonly', store => store.get(KEY))) !== undefined;
  } catch {
    return false;
  }
}
