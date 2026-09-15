import { MAX_CELDAS, newCell, type Cell, type Notebook } from './model';
import { MAX_OUTPUT_BYTES, type NotebookOutput } from '../protocol';

/**
 * Import y export de `.ipynb` (nbformat 4). El formato es el contrato con
 * Jupyter de escritorio y con el notebook que ya genera el laboratorio, así que
 * lo que entra se valida en vez de confiarse: un archivo puede venir de
 * cualquier lado y sus salidas se muestran sin ejecutarlas.
 */
export const MAX_IPYNB_BYTES = 20 * 1024 * 1024;
export const MAX_SALIDAS_POR_CELDA = 200;

const MIMES = ['image/png', 'image/svg+xml', 'text/html', 'text/markdown', 'text/plain'];
const TIPOS = new Set<Cell['type']>(['code', 'markdown', 'raw']);
const ID_VALIDO = /^[a-zA-Z0-9_-]{1,64}$/;
const medir = (texto: string): number => new TextEncoder().encode(texto).byteLength;

/** nbformat admite texto o lista de líneas en casi todos lados. */
function texto(valor: unknown): string {
  if (typeof valor === 'string') return valor;
  if (Array.isArray(valor)) return valor.filter(linea => typeof linea === 'string').join('');
  return '';
}

function datos(valor: unknown): Record<string, string> {
  const salida: Record<string, string> = {};
  if (!valor || typeof valor !== 'object') return salida;
  for (const mime of MIMES) {
    if (!Object.prototype.hasOwnProperty.call(valor, mime)) continue;
    const contenido = texto((valor as Record<string, unknown>)[mime]);
    if (contenido) salida[mime] = contenido;
  }
  return salida;
}

function salida(valor: unknown): NotebookOutput | null {
  if (!valor || typeof valor !== 'object') return null;
  const bruto = valor as Record<string, unknown>;
  if (bruto.output_type === 'stream') {
    const contenido = texto(bruto.text);
    if (!contenido) return null;                                   // un stream vacío no se dibuja
    return { output_type: 'stream', name: bruto.name === 'stderr' ? 'stderr' : 'stdout', text: contenido };
  }
  if (bruto.output_type === 'execute_result' || bruto.output_type === 'display_data') {
    const data = datos(bruto.data);
    if (!Object.keys(data).length) return null;
    const metadata = bruto.metadata && typeof bruto.metadata === 'object' ? bruto.metadata as Record<string, unknown> : {};
    if (bruto.output_type === 'display_data') return { output_type: 'display_data', data, metadata };
    const cuenta = typeof bruto.execution_count === 'number' ? bruto.execution_count : 0;
    return { output_type: 'execute_result', execution_count: cuenta, data, metadata };
  }
  if (bruto.output_type === 'error') {
    const traceback = Array.isArray(bruto.traceback) ? bruto.traceback.filter(l => typeof l === 'string') as string[] : [];
    const ename = String(bruto.ename ?? 'Error');
    const evalue = String(bruto.evalue ?? '');
    if (!traceback.length && !evalue && ename === 'Error') return null;
    return { output_type: 'error', ename, evalue, traceback };
  }
  return null;
}

function pesoDeSalida(output: NotebookOutput): number {
  if (output.output_type === 'stream') return medir(output.text);
  if (output.output_type === 'error') return medir(output.evalue) + medir(output.traceback.join('\n'));
  return Object.values(output.data).reduce((suma, valor) => suma + medir(valor), 0);
}

/**
 * Recorta lo que no entra en el presupuesto por celda y también la cantidad:
 * un notebook con miles de salidas haría miles de nodos en la página.
 */
function salidasDeCelda(valor: unknown): NotebookOutput[] {
  if (!Array.isArray(valor)) return [];
  const salidas: NotebookOutput[] = [];
  let bytes = 0;
  for (const bruta of valor) {
    const limpia = salida(bruta);
    if (!limpia) continue;
    bytes += pesoDeSalida(limpia);
    if (bytes > MAX_OUTPUT_BYTES || salidas.length >= MAX_SALIDAS_POR_CELDA) {
      salidas.push({ output_type: 'stream', name: 'stderr', text: '… salida recortada al abrir el archivo: pasa el límite de 1 MiB por celda.\n' });
      break;
    }
    salidas.push(limpia);
  }
  return salidas;
}

export function parseIpynb(contenido: string, nombrePorDefecto = 'Notebook importado'): Notebook {
  if (contenido.length * 2 > MAX_IPYNB_BYTES) throw new Error('El notebook supera 20 MiB.');
  let bruto: Record<string, unknown>;
  try {
    bruto = JSON.parse(contenido) as Record<string, unknown>;
  } catch {
    throw new Error('El archivo no es un .ipynb válido: no se pudo leer el JSON.');
  }
  if (!bruto || typeof bruto !== 'object') throw new Error('El archivo no es un .ipynb válido.');
  if (bruto.nbformat !== 4) throw new Error(`ChartPython abre notebooks nbformat 4; este dice ${JSON.stringify(bruto.nbformat ?? null)}.`);
  if (!Array.isArray(bruto.cells)) throw new Error('El notebook no trae la lista de celdas.');
  if (bruto.cells.length > MAX_CELDAS) throw new Error(`El notebook tiene ${bruto.cells.length} celdas; el máximo es ${MAX_CELDAS}.`);

  // La UI identifica cada celda por su id: uno repetido haría que dos celdas
  // compartan textarea y salidas, así que los repetidos se regeneran.
  const usados = new Set<string>();
  const celdas: Cell[] = bruto.cells.map(entrada => {
    const datosCelda = (entrada && typeof entrada === 'object' ? entrada : {}) as Record<string, unknown>;
    const declarado = String(datosCelda.cell_type ?? '') as Cell['type'];
    const tipo = TIPOS.has(declarado) && Object.prototype.hasOwnProperty.call(datosCelda, 'cell_type') ? declarado : 'raw';
    const celda = newCell(tipo, texto(datosCelda.source));
    const id = datosCelda.id;
    if (typeof id === 'string' && ID_VALIDO.test(id) && !usados.has(id)) celda.id = id;
    usados.add(celda.id);
    if (datosCelda.metadata && typeof datosCelda.metadata === 'object' && !Array.isArray(datosCelda.metadata)) {
      celda.metadata = { ...(datosCelda.metadata as Record<string, unknown>) };
    }
    if (tipo === 'code') {
      celda.executionCount = typeof datosCelda.execution_count === 'number' ? datosCelda.execution_count : null;
      celda.outputs = salidasDeCelda(datosCelda.outputs);
    }
    return celda;
  });

  const metadata = bruto.metadata && typeof bruto.metadata === 'object' && !Array.isArray(bruto.metadata)
    ? { ...(bruto.metadata as Record<string, unknown>) }
    : {};
  const ahora = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: nombrePorDefecto,
    cells: celdas.length ? celdas : [newCell()],
    metadata,
    createdAt: ahora,
    updatedAt: ahora,
  };
}

/** nbformat guarda el texto por líneas, conservando el salto al final de cada una. */
export function lineas(texto: string): string[] {
  return texto === '' ? [] : texto.split(/(?<=\n)/);
}

export function serializeIpynb(notebook: Notebook): string {
  const cells = notebook.cells.map(celda => {
    const base = { id: celda.id, cell_type: celda.type, metadata: celda.metadata, source: lineas(celda.source) };
    if (celda.type !== 'code') return base;
    return { ...base, execution_count: celda.executionCount, outputs: celda.outputs };
  });
  const documento = {
    cells,
    metadata: {
      ...notebook.metadata,
      kernelspec: { display_name: 'Python (ChartPython)', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.12', mimetype: 'text/x-python', file_extension: '.py' },
      chartbay: { app: 'chartpython', schemaVersion: 1, name: notebook.name, exportedAt: new Date().toISOString() },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(documento, null, 1) + '\n';
}

/** Nombre de archivo sugerido al exportar. */
export function nombreDeArchivo(notebook: Notebook): string {
  const limpio = notebook.name.replace(/[^\p{L}\p{N} ._-]/gu, '').trim() || 'notebook';
  return `${limpio}.ipynb`;
}
