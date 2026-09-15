// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { appendOutput, insertCell, moveCell, newCell, newNotebook, removeCell } from '../../src/chartpython/notebook/model';

describe('modelo del notebook', () => {
  it('pega los fragmentos consecutivos del mismo flujo', () => {
    const salidas = appendOutput(appendOutput([], { output_type: 'stream', name: 'stdout', text: 'hola ' }),
      { output_type: 'stream', name: 'stdout', text: 'mundo' });
    expect(salidas).toHaveLength(1);
    expect(salidas[0]).toMatchObject({ text: 'hola mundo' });
  });

  it('no mezcla stdout con stderr ni con un resultado', () => {
    let salidas = appendOutput([], { output_type: 'stream', name: 'stdout', text: 'a' });
    salidas = appendOutput(salidas, { output_type: 'stream', name: 'stderr', text: 'b' });
    salidas = appendOutput(salidas, { output_type: 'execute_result', execution_count: 1, data: { 'text/plain': '2' }, metadata: {} });
    salidas = appendOutput(salidas, { output_type: 'stream', name: 'stdout', text: 'c' });
    expect(salidas.map(s => s.output_type)).toEqual(['stream', 'stream', 'execute_result', 'stream']);
  });

  it('borrar devuelve la celda y su posición para poder deshacer', () => {
    const notebook = newNotebook();
    insertCell(notebook, 1, newCell('markdown', '# título'));
    const objetivo = notebook.cells[1];
    const borrada = removeCell(notebook, objetivo.id);
    expect(borrada?.index).toBe(1);
    expect(borrada?.cell.source).toBe('# título');
    insertCell(notebook, borrada!.index, borrada!.cell);
    expect(notebook.cells[1].id).toBe(objetivo.id);
  });

  it('un notebook nunca queda sin celdas', () => {
    const notebook = newNotebook();
    removeCell(notebook, notebook.cells[0].id);
    expect(notebook.cells).toHaveLength(1);
  });

  it('mover respeta los bordes', () => {
    const notebook = newNotebook();
    insertCell(notebook, 1, newCell('code', 'segunda'));
    expect(moveCell(notebook, notebook.cells[0].id, -1)).toBe(false);
    expect(moveCell(notebook, notebook.cells[0].id, 1)).toBe(true);
    expect(notebook.cells[1].source).toBe('');
    expect(notebook.cells[0].source).toBe('segunda');
  });
});
