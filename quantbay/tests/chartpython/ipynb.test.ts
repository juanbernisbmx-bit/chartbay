// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { MAX_SALIDAS_POR_CELDA, lineas, parseIpynb, serializeIpynb } from '../../src/chartpython/notebook/ipynb';
import { newNotebook } from '../../src/chartpython/notebook/model';

const notebookDe = (celdas: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ cells: celdas, metadata: {}, nbformat: 4, nbformat_minor: 5, ...extra });

describe('importar .ipynb', () => {
  it('rechaza lo que no es un notebook 4', () => {
    expect(() => parseIpynb('{no json')).toThrow(/no se pudo leer el JSON/);
    expect(() => parseIpynb(notebookDe([], { nbformat: 3 }))).toThrow(/nbformat 4/);
    expect(() => parseIpynb(JSON.stringify({ nbformat: 4 }))).toThrow(/lista de celdas/);
  });

  it('abre el notebook que genera el laboratorio, sin ids', () => {
    const generado = notebookDe([
      { cell_type: 'markdown', metadata: {}, source: ['# Análisis\n', 'texto\n'] },
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['import pandas as pd\n'] },
    ]);
    const notebook = parseIpynb(generado, 'analisis');
    expect(notebook.name).toBe('analisis');
    expect(notebook.cells.map(c => c.type)).toEqual(['markdown', 'code']);
    expect(notebook.cells[0].source).toBe('# Análisis\ntexto\n');
    expect(notebook.cells.every(c => c.id.length > 0)).toBe(true);
  });

  it('regenera los ids repetidos: la interfaz identifica las celdas por id', () => {
    const notebook = parseIpynb(notebookDe([
      { cell_type: 'code', id: 'uno', source: 'a', outputs: [], execution_count: 1 },
      { cell_type: 'code', id: 'uno', source: 'b', outputs: [], execution_count: 2 },
      { cell_type: 'code', id: 'con espacios', source: 'c', outputs: [], execution_count: 3 },
    ]));
    const ids = notebook.cells.map(c => c.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('uno');
    expect(ids[2]).not.toBe('con espacios');
  });

  it('un cell_type heredado del prototipo no pasa como tipo', () => {
    const notebook = parseIpynb(notebookDe([
      { cell_type: 'constructor', source: 'x' },
      { cell_type: '__proto__', source: 'y' },
      { source: 'z' },
    ]));
    expect(notebook.cells.map(c => c.type)).toEqual(['raw', 'raw', 'raw']);
    expect(notebook.cells.every(c => typeof c.type === 'string')).toBe(true);
  });

  it('descarta salidas vacías o de tipos que no se muestran', () => {
    const notebook = parseIpynb(notebookDe([{
      cell_type: 'code', source: 'x', execution_count: 1,
      outputs: [
        { output_type: 'stream', name: 'stdout', text: '' },
        { output_type: 'display_data', data: { 'application/vnd.plotly.v1+json': '{}' }, metadata: {} },
        { output_type: 'execute_result', execution_count: 1, data: { 'text/plain': '42', 'text/html': '<b>42</b>' }, metadata: {} },
        { output_type: 'error', ename: 'ValueError', evalue: 'mal', traceback: ['Traceback', 'ValueError: mal'] },
      ],
    }]));
    const salidas = notebook.cells[0].outputs;
    expect(salidas.map(s => s.output_type)).toEqual(['execute_result', 'error']);
    expect(salidas[0]).toMatchObject({ data: { 'text/plain': '42', 'text/html': '<b>42</b>' } });
  });

  it('recorta por tamaño y por cantidad', () => {
    const enorme = notebookDe([{
      cell_type: 'code', source: 'x', execution_count: 1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'a'.repeat(1024 * 1024 + 10) }],
    }]);
    const recortado = parseIpynb(enorme).cells[0].outputs;
    expect(recortado).toHaveLength(1);
    expect(recortado[0]).toMatchObject({ name: 'stderr' });

    const muchas = notebookDe([{
      cell_type: 'code', source: 'x', execution_count: 1,
      outputs: Array.from({ length: MAX_SALIDAS_POR_CELDA + 50 }, (_, i) => ({
        output_type: 'display_data', data: { 'text/plain': String(i) }, metadata: {},
      })),
    }]);
    expect(parseIpynb(muchas).cells[0].outputs.length).toBeLessThanOrEqual(MAX_SALIDAS_POR_CELDA + 1);
  });
});

describe('exportar .ipynb', () => {
  it('parte el texto en líneas como nbformat', () => {
    expect(lineas('uno\ndos\n')).toEqual(['uno\n', 'dos\n']);
    expect(lineas('')).toEqual([]);
  });

  it('va y vuelve sin perder nada', () => {
    const notebook = newNotebook('Trabajo práctico');
    notebook.cells[0].source = 'df = pd.DataFrame({"a": [1, 2]})\ndf\n';
    notebook.cells[0].executionCount = 3;
    notebook.cells[0].outputs = [{ output_type: 'execute_result', execution_count: 3, data: { 'text/plain': '   a\n0  1' }, metadata: {} }];
    const texto = serializeIpynb(notebook);
    const documento = JSON.parse(texto);
    expect(documento.nbformat).toBe(4);
    expect(documento.nbformat_minor).toBe(5);
    expect(documento.metadata.kernelspec.name).toBe('python3');
    const vuelta = parseIpynb(texto, 'Trabajo práctico');
    expect(vuelta.cells[0].source).toBe(notebook.cells[0].source);
    expect(vuelta.cells[0].executionCount).toBe(3);
    expect(vuelta.cells[0].outputs).toEqual(notebook.cells[0].outputs);
    expect(vuelta.cells[0].id).toBe(notebook.cells[0].id);
  });
});
