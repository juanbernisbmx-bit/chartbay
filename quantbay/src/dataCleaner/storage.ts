import type { Row } from './model';
export const BATCH_BYTES = 512 * 1024;
export const MAX_ROW_BYTES = 4 * 1024 * 1024;
export const MAX_COLUMNS = 4096;
const stores = ['rows', 'seen', 'strings', 'numbers', 'categories', 'keys', 'comparison'] as const;
type Store = typeof stores[number];
export class CleanerStorage {
  private constructor(readonly db: IDBDatabase) {}
  static async open(name: string): Promise<CleanerStorage> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => stores.forEach(s => { if (!request.result.objectStoreNames.contains(s)) request.result.createObjectStore(s); });
      request.onsuccess = () => resolve(new CleanerStorage(request.result));
      request.onerror = () => reject(request.error);
    });
  }
  async transaction<T>(store: Store, mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T>): Promise<T> {
    const tx = this.db.transaction(store, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('No se pudo guardar: revisá el espacio disponible.'));
    });
    try {
      const result = await run(tx.objectStore(store));
      await done;
      return result;
    } catch (error) {
      try { tx.abort(); } catch { /* already finished */ }
      await done.catch(() => undefined);
      throw error;
    }
  }
  async put(store: Store, key: IDBValidKey, value: unknown): Promise<void> {
    await this.transaction(store, 'readwrite', async s => { await request(s.put(value, key)); });
  }
  async get<T>(store: Store, key: IDBValidKey): Promise<T> {
    return this.transaction(store, 'readonly', async s => request(s.get(key)));
  }
  async strings(entries: [number, string][]): Promise<void> {
    await this.transaction('strings', 'readwrite', async s => {
      await Promise.all(entries.map(([key, value]) => request(s.put(value, key))));
    });
  }
  async markDuplicates(rows: Row[]): Promise<void> {
    await this.transaction('seen', 'readwrite', async s => {
      // Sequential requests inside one transaction also catch duplicates within a batch.
      for (const row of rows) {
        delete row.duplicateOf;
        const key = JSON.stringify(row.cells);
        const first = await request<number | undefined>(s.get(key));
        if (first !== undefined) row.duplicateOf = first;
        else await request(s.put(row.n, key));
      }
    });
  }
  async clear(store: Store): Promise<void> {
    await this.transaction(store, 'readwrite', async s => { await request(s.clear()); });
  }
  async putMany(store: Store, entries: [IDBValidKey, unknown][]): Promise<void> {
    await this.transaction(store, 'readwrite', async s => { await Promise.all(entries.map(([key, value]) => request(s.put(value, key)))); });
  }
  async getMany<T>(store: Store, keys: IDBValidKey[]): Promise<(T | undefined)[]> {
    return this.transaction(store, 'readonly', async s => Promise.all(keys.map(key => request<T | undefined>(s.get(key)))));
  }
  async *pages<T>(store: Store, size = 128): AsyncGenerator<{ key: IDBValidKey; value: T }[]> {
    let last: IDBValidKey | undefined;
    while (true) {
      const range = last === undefined ? undefined : IDBKeyRange.lowerBound(last, true);
      const page = await this.transaction(store, 'readonly', s => new Promise<{key: IDBValidKey; value: T}[]>((resolve, reject) => {
        const rows: { key: IDBValidKey; value: T }[] = [];
        let bytes = 0;
        const cursor = s.openCursor(range);
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          if (!cursor.result || rows.length === size) { resolve(rows); return; }
          rows.push({ key: cursor.result.key, value: cursor.result.value });
          bytes += JSON.stringify([cursor.result.key, cursor.result.value]).length * 2;
          if (rows.length >= size || bytes >= BATCH_BYTES) resolve(rows);
          else cursor.result.continue();
        };
      }));
      if (!page.length) return;
      yield page;
      last = page[page.length - 1].key;
    }
  }
  /** Exact order statistics via the on-disk numeric index; no full-column array. */
  async quantiles(column: number, count: number, probabilities: number[]): Promise<(number | null)[]> {
    if (!count) return probabilities.map(() => null);
    const positions = probabilities.map(p => p * (count - 1));
    const ranks = [...new Set(positions.flatMap(p => [Math.floor(p), Math.ceil(p)]))].sort((a, b) => a - b);
    const values = await this.transaction('numbers', 'readonly', s => new Promise<Map<number, number>>((resolve, reject) => {
      const found = new Map<number, number>();
      let rank = 0, target = 0;
      const req = s.openKeyCursor(IDBKeyRange.bound([column], [column, []]));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { reject(new Error('Índice numérico incompleto.')); return; }
        if (rank < ranks[target]) { const jump = ranks[target] - rank; rank += jump; cursor.advance(jump); return; }
        found.set(rank, (cursor.key as number[])[1]);
        if (++target === ranks.length) { resolve(found); return; }
        const jump = ranks[target] - rank; rank += jump; cursor.advance(jump);
      };
    }));
    return positions.map(p => values.get(Math.floor(p))! * (1 - (p % 1)) + values.get(Math.ceil(p))! * (p % 1));
  }
  async clearSeen(): Promise<void> {
    await this.transaction('seen', 'readwrite', async s => { await request(s.clear()); });
  }
  close(): void { this.db.close(); }
}
export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
export function deleteStorage(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Cerrá la sesión anterior del limpiador.'));
  });
}
