import type { NotebookOutput } from '../protocol';

/**
 * El notebook en memoria. `source` es texto plano porque es lo que edita un
 * textarea; el `.ipynb` lo guarda partido en líneas y esa traducción vive en
 * ipynb.ts. Las salidas usan las formas de nbformat que ya manda el kernel, así
 * que exportar no las traduce.
 */
export interface Cell {
  id: string;
  type: 'code' | 'markdown' | 'raw';
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
  metadata: Record<string, unknown>;
}

export interface Notebook {
  id: string;
  name: string;
  cells: Cell[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export const MAX_CELDAS = 2000;

const nuevoId = (): string => crypto.randomUUID();

export function newCell(type: Cell['type'] = 'code', source = ''): Cell {
  return { id: nuevoId(), type, source, executionCount: null, outputs: [], metadata: {} };
}

export function newNotebook(name = 'Notebook sin título'): Notebook {
  const ahora = new Date().toISOString();
  return { id: nuevoId(), name, cells: [newCell()], metadata: {}, createdAt: ahora, updatedAt: ahora };
}

/**
 * nbformat guarda un solo output por flujo consecutivo, pero el kernel manda
 * fragmentos a medida que la celda imprime. Pegarlos acá es lo que hace que el
 * `.ipynb` exportado se vea como el de Jupyter y que un `print` en un bucle no
 * genere miles de bloques en pantalla.
 */
export function appendOutput(outputs: NotebookOutput[], output: NotebookOutput): NotebookOutput[] {
  const ultimo = outputs[outputs.length - 1];
  if (output.output_type === 'stream' && ultimo && ultimo.output_type === 'stream' && ultimo.name === output.name) {
    outputs[outputs.length - 1] = { ...ultimo, text: ultimo.text + output.text };
    return outputs;
  }
  outputs.push(output);
  return outputs;
}

export function indexOfCell(notebook: Notebook, cellId: string): number {
  return notebook.cells.findIndex(celda => celda.id === cellId);
}

export function insertCell(notebook: Notebook, index: number, cell: Cell): Cell {
  const posicion = Math.max(0, Math.min(index, notebook.cells.length));
  if (notebook.cells.length >= MAX_CELDAS) throw new Error(`Un notebook admite hasta ${MAX_CELDAS} celdas.`);
  notebook.cells.splice(posicion, 0, cell);
  return cell;
}

/** Devuelve la celda borrada para poder deshacer con Z, como en Jupyter. */
export function removeCell(notebook: Notebook, cellId: string): { cell: Cell; index: number } | null {
  const index = indexOfCell(notebook, cellId);
  if (index < 0) return null;
  const [cell] = notebook.cells.splice(index, 1);
  // Un notebook sin celdas no se puede editar: se repone una vacía.
  if (!notebook.cells.length) notebook.cells.push(newCell());
  return { cell, index };
}

export function moveCell(notebook: Notebook, cellId: string, delta: number): boolean {
  const index = indexOfCell(notebook, cellId);
  const destino = index + delta;
  if (index < 0 || destino < 0 || destino >= notebook.cells.length) return false;
  const [cell] = notebook.cells.splice(index, 1);
  notebook.cells.splice(destino, 0, cell);
  return true;
}

export function clearOutputs(notebook: Notebook): void {
  for (const celda of notebook.cells) {
    celda.outputs = [];
    celda.executionCount = null;
  }
}

export function touch(notebook: Notebook): void {
  notebook.updatedAt = new Date().toISOString();
}
