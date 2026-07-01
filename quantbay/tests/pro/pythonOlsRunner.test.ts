import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PyodideInterface } from '../../src/pro/pyodide/pyodideTypes';

const mocks = vi.hoisted(() => ({
  getPyodide: vi.fn(),
}));

vi.mock('../../src/pro/pyodide/pyodideLoader', () => ({
  getPyodide: mocks.getPyodide,
}));

import { runPyodideOls } from '../../src/pro/pyodide/pythonOlsRunner';

const CSV = 'y,x\n3,1\n5,2\n7,3\n9,4\n11,5\n';

const VALID_STATSMODELS_PAYLOAD = {
  ok: true,
  engine: 'pyodide',
  nobs: 5,
  coefficients: [
    { name: 'Intercept', estimate: 1.0, stdError: 0.0, tStat: null, pValue: null },
    { name: 'x', estimate: 2.0, stdError: 0.0, tStat: null, pValue: null },
  ],
  rSquared: 1.0,
  rSquaredAdj: 1.0,
  fStat: null,
  fPValue: null,
  dfResid: 3,
  residualStdError: 0.0,
  residuals: [0, 0, 0, 0, 0],
  fitted: [3, 5, 7, 9, 11],
  warnings: [],
};

function makeFakePyodide(overrides: Partial<PyodideInterface> = {}): PyodideInterface {
  return {
    loadPackage: vi.fn().mockResolvedValue(undefined),
    runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify(VALID_STATSMODELS_PAYLOAD)),
    globals: { set: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getPyodide.mockReset();
});

describe('runPyodideOls (statsmodels)', () => {
  it('runs the bridge end to end with a mocked Pyodide', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const phases: string[] = [];
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] }, phase => phases.push(phase));

    expect(result.ok).toBe(true);
    expect(result.engine).toBe('pyodide');
    expect(result.nobs).toBe(5);
    expect(result.dfResid).toBe(3);
    expect(result.coefficients?.[0]).toEqual({ name: 'Intercept', estimate: 1.0, stdError: 0.0, tStat: null, pValue: null });
    expect(result.coefficients?.[1]).toEqual({ name: 'x', estimate: 2.0, stdError: 0.0, tStat: null, pValue: null });
    expect(result.residuals).toEqual([0, 0, 0, 0, 0]);
    expect(result.fitted).toEqual([3, 5, 7, 9, 11]);
    expect(phases).toEqual(['loading-pyodide', 'loading-packages', 'running']);

    expect(fake.loadPackage).toHaveBeenCalledWith(['numpy', 'pandas', 'statsmodels']);
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_csv_text', CSV);
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_y_name', 'y');
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_x_names_json', JSON.stringify(['x']));
  });

  it('sends a Python script that uses statsmodels OLS', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('import statsmodels.api as sm');
    expect(script).toContain('sm.OLS(y, X).fit()');
    expect(script).toContain('sm.add_constant');
  });

  it('the Python script nulls out the F-stat when Y is (near) constant, since it can never be negative', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('f_stat < 0');
    expect(script).toContain('r_squared is None');
  });

  it('returns a clear error when the CSV text is empty, without touching Pyodide', async () => {
    const result = await runPyodideOls({ csvText: '   ', yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No hay CSV cargado');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('returns a clear error when no Y variable is selected', async () => {
    const result = await runPyodideOls({ csvText: CSV, yName: '', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('variable Y');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('returns a clear error when no X variables are selected', async () => {
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: [] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('al menos una variable X');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('reports Pyodide load failures without throwing', async () => {
    mocks.getPyodide.mockRejectedValue(new Error('CDN caído'));
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No se pudo cargar Pyodide');
    expect(result.error).toContain('CDN caído');
  });

  it('reports package load failures mentioning statsmodels without throwing', async () => {
    const fake = makeFakePyodide({ loadPackage: vi.fn().mockRejectedValue(new Error('sin red')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('numpy/pandas/statsmodels');
  });

  it('reports Python execution failures without throwing', async () => {
    const fake = makeFakePyodide({ runPythonAsync: vi.fn().mockRejectedValue(new Error('SyntaxError')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Error ejecutando OLS con statsmodels');
  });

  it('passes Python-side missing-column errors through', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(
        JSON.stringify({ ok: false, engine: 'pyodide', warnings: [], error: 'Columnas faltantes en el CSV: z.' })
      ),
    });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['z'] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Columnas faltantes en el CSV: z.');
  });

  it('passes Python-side empty-CSV errors through', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(
        JSON.stringify({ ok: false, engine: 'pyodide', warnings: [], error: 'El CSV no tiene filas de datos.' })
      ),
    });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: 'y,x\n', yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('El CSV no tiene filas de datos.');
  });
});
