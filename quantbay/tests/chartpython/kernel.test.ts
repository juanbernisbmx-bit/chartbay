import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { generateNotebook } from '../../src/reproducibility/generator';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { PythonRuntime, filePath, type PythonEngine } from '../../src/chartpython/pythonRuntime';
import { MAX_CODE_BYTES, MAX_FILE_BYTES, type NotebookOutput } from '../../src/chartpython/protocol';
const require = createRequire(import.meta.url);
let runtime: PythonRuntime;
const text = (outputs: NotebookOutput[]) => outputs.map(o => o.output_type === 'stream' ? o.text : o.output_type === 'error' ? o.evalue : o.data['text/plain']).join('');
beforeAll(async () => {
  const dir = resolve(process.cwd(), '../web/static/vendor/pyodide/0.26.4');
  const { loadPyodide } = require(resolve(dir, 'pyodide.js'));
  const py = await loadPyodide({ indexURL: dir + '/', packages: ['statsmodels'], stdout() {}, stderr() {}, stdin: () => undefined });
  runtime = new PythonRuntime(py as PythonEngine);
  await runtime.initialize();
}, 60_000);
afterAll(() => runtime?.dispose());
describe('ChartPython with the vendored CPython/WASM', () => {
  it('shares variables and numbers executions', async () => {
    const first = await runtime.execute('income = 21');
    const second = await runtime.execute('income * 2');
    expect(second.executionCount).toBe(first.executionCount + 1);
    expect(text(second.outputs)).toBe('42');
  });
  it('streams stdout/stderr in order without mutating callback fragments', async () => {
    const fragments: NotebookOutput[] = [];
    const result = await runtime.execute('import sys\nprint("uno", end="")\nsys.stderr.write("aviso")\nprint("dos")', output => fragments.push(output));
    expect(result.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'uno' },
      { output_type: 'stream', name: 'stderr', text: 'aviso' },
      { output_type: 'stream', name: 'stdout', text: 'dos\n' },
    ]);
    expect(fragments[2]).toEqual({ output_type: 'stream', name: 'stdout', text: 'dos' });
  });
  it('preserves state on errors with useful tracebacks', async () => {
    const result = await runtime.execute('saved_before_error = 19\n1 / 0');
    expect(result.status).toBe('error');
    const error = result.outputs[0];
    expect(error.output_type).toBe('error');
    if (error.output_type === 'error') {
      expect(error.ename).toBe('ZeroDivisionError');
      expect(error.traceback.join('')).toContain('ChartPython cell');
      expect(error.traceback.join('')).toContain('1 / 0');
    }
    expect(text((await runtime.execute('saved_before_error')).outputs)).toBe('19');
    expect((await runtime.execute('if :')).status).toBe('error');
    expect((await runtime.execute('raise SystemExit(2)')).status).toBe('error');
    expect(text((await runtime.execute('6 * 7')).outputs)).toBe('42');
  });
  it('supports await and the trailing-semicolon convention', async () => {
    expect(text((await runtime.execute('import asyncio\nawait asyncio.sleep(0)\n7')).outputs)).toBe('7');
    expect((await runtime.execute('7;')).outputs).toEqual([]);
  });
  it('isolates wrapper names from user variables', async () => {
    expect(text((await runtime.execute('json = "user"\nexecute = None\n_code = "mine"\n20 + 22')).outputs)).toBe('42');
    expect(text((await runtime.execute('_code')).outputs)).toBe("'mine'");
  });
  it('returns pandas HTML tables and multiple display outputs', async () => {
    const result = await runtime.execute('import pandas as pd\ndf = pd.DataFrame({"id": ["001", "NA"], "valor": ["1.234", ""]})\ndisplay(df)\ndf');
    expect(result.outputs.map(o => o.output_type)).toEqual(['display_data', 'execute_result']);
    const output = result.outputs[0];
    if (output.output_type === 'display_data') {
      expect(output.data['text/html']).toContain('<table');
      expect(output.data['text/plain']).toContain('001');
    }
  });
  it('loads the same statsmodels package as Pro', async () => {
    const result = await runtime.execute('import statsmodels.api as sm\nsm.OLS([1, 3, 5, 7], sm.add_constant([0, 1, 2, 3])).fit().params.round(6).tolist()');
    expect(result.status).toBe('ok');
    expect(text(result.outputs)).toBe('[1.0, 2.0]');
  });
  it('roundtrips files and generated CSVs', async () => {
    const bytes = new TextEncoder().encode('id,provincia\n001,Córdoba\nNA,\n');
    expect(runtime.upload('datos.csv', bytes)).toBe('/mnt/data/datos.csv');
    expect(Array.from(runtime.download('datos.csv'))).toEqual(Array.from(bytes));
    const result = await runtime.execute('uploaded = pd.read_csv("datos.csv", dtype=str, keep_default_na=False)\nuploaded.to_csv("salida.csv", index=False)\nuploaded.iloc[0, 0]');
    expect(text(result.outputs)).toBe("'001'");
    expect(runtime.listFiles().map(f => f.name)).toContain('salida.csv');
    expect(new TextDecoder().decode(runtime.download('salida.csv'))).toBe(new TextDecoder().decode(bytes));
  });
  it('runs a notebook exported by the existing econometrics lab', async () => {
    const csv = 'x,y\n' + Array.from({ length: 24 }, (_, i) => `${i},${3 + 2 * i + (i % 3 - 1) * .2}`).join('\n') + '\n';
    runtime.upload('modelo.csv', new TextEncoder().encode(csv));
    const notebook = JSON.parse(generateNotebook({
      schemaVersion: 1, generatedAt: '2026-09-15T00:00:00Z', datasetName: 'modelo.csv', mode: 'regression', engine: 'pro',
      regression: { yName: 'y', xNames: ['x'], expandedXNames: ['x'], functionalForm: 'lin-lin', dropIncompleteRows: true,
        standardErrorType: 'HC3', hacMaxLags: null, categoricalEncodings: [], restriction: null, autoRepair: false },
      timeSeries: { dateColumn: null, valueColumn: 'y', transformation: 'original', movingAverageWindow: 3, maxLag: 4,
        adfRegression: 'c', runArima: false, arimaOrder: { p: 1, d: 0, q: 0 }, forecastSteps: 3 },
    }));
    const result = await runtime.execute(notebook.cells[1].source.join(''));
    expect(result.status).toBe('ok');
    expect(text(result.outputs)).toContain('OLS Regression Results');
    expect(text(result.outputs)).toContain('HC3');
    expect(text((await runtime.execute('int(results.nobs)')).outputs)).toBe('24');
  });
  it('rejects invalid paths, oversized files and symlinks', async () => {
    for (const name of ['../passwords', '/tmp/a', 'x/y', 'x\\y', '.', '..', 'bad\0.csv']) expect(() => filePath(name)).toThrow();
    expect(() => runtime.upload('too-big', new Uint8Array(MAX_FILE_BYTES + 1))).toThrow('10 MiB');
    await runtime.execute('import os\nos.symlink("/etc/hosts", "/mnt/data/link")');
    expect(() => runtime.download('link')).toThrow('enlaces');
    expect(() => runtime.upload('link', new Uint8Array(2))).toThrow('enlace');
    expect(runtime.listFiles().some(f => f.name === 'link')).toBe(false);
  });
  it('keeps saved display helpers attached to the current cell', async () => {
    const first = await runtime.execute('show = display');
    const second = await runtime.execute('show(123)');
    expect(first.outputs).toEqual([]);
    expect(text(second.outputs)).toBe('123');
  });
  it('explains unsupported interactive input without hanging', async () => {
    const result = await runtime.execute('input("Valor: ")');
    expect(result.status).toBe('error');
    expect(text(result.outputs)).toContain('input() no está disponible');
  });
  it('keeps a prefix and labels an oversized single print', async () => {
    const result = await runtime.execute('print("z" * 2000000)');
    expect(text(result.outputs)).toMatch(/^zzzz/);
    expect(text(result.outputs)).toContain('Salida truncada');
    expect(text(result.outputs).length).toBeLessThan(1024 * 1024);
  });
  it('bounds print floods and code size', async () => {
    const result = await runtime.execute('for i in range(3000):\n    print("x")\nfinished = True');
    expect(result.status).toBe('ok');
    expect(text(result.outputs)).toContain('Salida truncada');
    expect(text((await runtime.execute('finished')).outputs)).toBe('True');
    await expect(runtime.execute('#' + 'x'.repeat(MAX_CODE_BYTES))).rejects.toThrow('100 KiB');
  });
});
