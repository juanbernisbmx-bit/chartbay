// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  abrir, borrarArchivo, borrarNotebook, guardarArchivo, guardarNotebook, leerArchivo, leerNotebook,
  listarArchivos, listarNotebooks,
} from '../../src/chartpython/notebook/storage';
import { newNotebook } from '../../src/chartpython/notebook/model';
import { MAX_FILE_BYTES } from '../../src/chartpython/protocol';

const bases: IDBDatabase[] = [];
async function base(): Promise<IDBDatabase> {
  const db = await abrir('chartpython-' + crypto.randomUUID());
  bases.push(db);
  return db;
}
afterEach(() => { for (const db of bases.splice(0)) db.close(); });

describe('almacenamiento local', () => {
  it('guarda, lista y borra notebooks', async () => {
    const db = await base();
    const uno = newNotebook('Uno');
    const dos = newNotebook('Dos');
    await guardarNotebook(db, uno);
    await guardarNotebook(db, dos);
    const lista = await listarNotebooks(db);
    expect(lista.map(n => n.name).sort()).toEqual(['Dos', 'Uno']);
    expect((await leerNotebook(db, uno.id))?.name).toBe('Uno');
    await borrarNotebook(db, uno.id);
    expect(await leerNotebook(db, uno.id)).toBeNull();
    expect(await listarNotebooks(db)).toHaveLength(1);
  });

  it('separa los archivos por notebook y los ordena', async () => {
    const db = await base();
    await guardarArchivo(db, 'nb-1', 'ventas.csv', new ArrayBuffer(10));
    await guardarArchivo(db, 'nb-1', 'altas.csv', new ArrayBuffer(20));
    await guardarArchivo(db, 'nb-2', 'otro.csv', new ArrayBuffer(30));
    expect((await listarArchivos(db, 'nb-1')).map(a => a.name)).toEqual(['altas.csv', 'ventas.csv']);
    expect((await leerArchivo(db, 'nb-2', 'otro.csv'))?.size).toBe(30);
    await borrarArchivo(db, 'nb-1', 'altas.csv');
    expect(await listarArchivos(db, 'nb-1')).toHaveLength(1);
  });

  it('respeta los límites del kernel: 10 MiB por archivo y 20 MiB en total', async () => {
    const db = await base();
    await expect(guardarArchivo(db, 'nb', 'gigante.csv', new ArrayBuffer(MAX_FILE_BYTES + 1)))
      .rejects.toThrow(/10 MiB/);
    await guardarArchivo(db, 'nb', 'a.csv', new ArrayBuffer(MAX_FILE_BYTES));
    await guardarArchivo(db, 'nb', 'b.csv', new ArrayBuffer(MAX_FILE_BYTES));
    await expect(guardarArchivo(db, 'nb', 'c.csv', new ArrayBuffer(1024)))
      .rejects.toThrow(/20 MiB/);
    // Reemplazar uno que ya está no cuenta dos veces.
    await expect(guardarArchivo(db, 'nb', 'b.csv', new ArrayBuffer(1024))).resolves.toBeDefined();
  });

  it('borrar un notebook se lleva sus archivos', async () => {
    const db = await base();
    const notebook = newNotebook('Con datos');
    await guardarNotebook(db, notebook);
    await guardarArchivo(db, notebook.id, 'datos.csv', new ArrayBuffer(8));
    await borrarNotebook(db, notebook.id);
    expect(await listarArchivos(db, notebook.id)).toHaveLength(0);
  });
});
