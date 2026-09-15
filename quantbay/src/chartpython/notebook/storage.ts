import { MAX_FILE_BYTES, MAX_FILES_BYTES } from '../protocol';
import type { Notebook } from './model';

/**
 * Todo vive en el navegador, como el resto de ChartBay: los notebooks y los
 * archivos que se suben quedan en IndexedDB de este equipo y no viajan a
 * ningún servidor. Los archivos se guardan acá además de en el kernel porque
 * el kernel los pierde al reiniciarse, y la UI los repone.
 */
const BASE = 'chartpython';
const VERSION = 1;
const ULTIMO = 'chartpython-ultimo-notebook';

export interface NotebookResumen {
  id: string;
  name: string;
  updatedAt: string;
  celdas: number;
}

export interface ArchivoGuardado {
  notebookId: string;
  name: string;
  size: number;
  bytes: ArrayBuffer;
  updatedAt: string;
}

function pedido<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('No se pudo usar el almacenamiento del navegador.'));
  });
}

export function abrir(nombre = BASE): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(nombre, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('notebooks')) db.createObjectStore('notebooks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('archivos')) db.createObjectStore('archivos', { keyPath: ['notebookId', 'name'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('No se pudo abrir el almacenamiento del navegador.'));
  });
}

async function conStore<T>(db: IDBDatabase, store: 'notebooks' | 'archivos', modo: IDBTransactionMode, usar: (s: IDBObjectStore) => Promise<T>): Promise<T> {
  const tx = db.transaction(store, modo);
  const terminada = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('No se pudo guardar: revisá el espacio disponible.'));
  });
  try {
    const resultado = await usar(tx.objectStore(store));
    await terminada;
    return resultado;
  } catch (error) {
    // Si falla el pedido, la transacción también va a rechazar: hay que
    // consumir ese rechazo o queda uno sin manejar dando vueltas.
    try { tx.abort(); } catch { /* ya había terminado */ }
    await terminada.catch(() => undefined);
    throw error;
  }
}

export async function guardarNotebook(db: IDBDatabase, notebook: Notebook): Promise<void> {
  await conStore(db, 'notebooks', 'readwrite', async store => { await pedido(store.put(notebook)); });
}

export async function leerNotebook(db: IDBDatabase, id: string): Promise<Notebook | null> {
  return conStore(db, 'notebooks', 'readonly', async store => (await pedido<Notebook | undefined>(store.get(id))) ?? null);
}

export async function listarNotebooks(db: IDBDatabase): Promise<NotebookResumen[]> {
  const todos = await conStore(db, 'notebooks', 'readonly', store => pedido<Notebook[]>(store.getAll()));
  return todos
    .map(n => ({ id: n.id, name: n.name, updatedAt: n.updatedAt, celdas: n.cells.length }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function borrarNotebook(db: IDBDatabase, id: string): Promise<void> {
  await conStore(db, 'notebooks', 'readwrite', async store => { await pedido(store.delete(id)); });
  const archivos = await listarArchivos(db, id);
  for (const archivo of archivos) await borrarArchivo(db, id, archivo.name);
}

export async function listarArchivos(db: IDBDatabase, notebookId: string): Promise<ArchivoGuardado[]> {
  const rango = IDBKeyRange.bound([notebookId, ''], [notebookId, '￿']);
  const archivos = await conStore(db, 'archivos', 'readonly', store => pedido<ArchivoGuardado[]>(store.getAll(rango)));
  return archivos.sort((a, b) => a.name.localeCompare(b.name));
}

export async function guardarArchivo(db: IDBDatabase, notebookId: string, name: string, bytes: ArrayBuffer): Promise<ArchivoGuardado> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('Cada archivo puede ocupar hasta 10 MiB.');
  const previos = await listarArchivos(db, notebookId);
  const ocupado = previos.filter(a => a.name !== name).reduce((suma, a) => suma + a.size, 0);
  if (ocupado + bytes.byteLength > MAX_FILES_BYTES) throw new Error('Los archivos de este notebook superan los 20 MiB. Borrá alguno antes de subir otro.');
  const archivo: ArchivoGuardado = { notebookId, name, size: bytes.byteLength, bytes, updatedAt: new Date().toISOString() };
  await conStore(db, 'archivos', 'readwrite', async store => { await pedido(store.put(archivo)); });
  return archivo;
}

export async function leerArchivo(db: IDBDatabase, notebookId: string, name: string): Promise<ArchivoGuardado | null> {
  return conStore(db, 'archivos', 'readonly', async store => (await pedido<ArchivoGuardado | undefined>(store.get([notebookId, name]))) ?? null);
}

export async function borrarArchivo(db: IDBDatabase, notebookId: string, name: string): Promise<void> {
  await conStore(db, 'archivos', 'readwrite', async store => { await pedido(store.delete([notebookId, name])); });
}

/** El último notebook abierto se recuerda para volver a él al entrar. */
export function recordarUltimo(id: string): void {
  try { localStorage.setItem(ULTIMO, id); } catch { /* modo privado */ }
}

export function ultimoNotebook(): string | null {
  try { return localStorage.getItem(ULTIMO); } catch { return null; }
}
