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

function makeFakePyodide(overrides: Partial<PyodideInterface> = {}): PyodideInterface {
  return {
    loadPackage: vi.fn().mockResolvedValue(undefined),
    runPythonAsync: vi.fn().mockResolvedValue(
      JSON.stringify({
        ok: true,
        engine: 'pyodide',
        nobs: 5,
        coefficients: [
          { name: 'Intercept', estimate: 1.0 },
          { name: 'x', estimate: 2.0 },
        ],
        rSquared: 1.0,
        residualStdError: 0.0,
        warnings: [],
      })
    ),
    globals: { set: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  mocks.getPyodide.mockReset();
});

describe('runPyodideOls', () => {
  it('runs the bridge end to end with a mocked Pyodide', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const phases: string[] = [];
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] }, phase => phases.push(phase));

    expect(result.ok).toBe(true);
    expect(result.engine).toBe('pyodide');
    expect(result.nobs).toBe(5);
    expect(result.coefficients?.[0]).toEqual({ name: 'Intercept', estimate: 1.0 });
    expect(result.coefficients?.[1]).toEqual({ name: 'x', estimate: 2.0 });
    expect(phases).toEqual(['loading-pyodide', 'loading-packages', 'running']);

    expect(fake.loadPackage).toHaveBeenCalledWith(['numpy', 'pandas']);
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_csv_text', CSV);
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_y_name', 'y');
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_x_names_json', JSON.stringify(['x']));
  });

  it('returns a clear error when the CSV text is empty, without touching Pyodide', async () => {
    const result = await runPyodideOls({ csvText: '   ', yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No hay CSV cargado');
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

  it('reports package load failures without throwing', async () => {
    const fake = makeFakePyodide({ loadPackage: vi.fn().mockRejectedValue(new Error('sin red')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('numpy/pandas');
  });

  it('reports Python execution failures without throwing', async () => {
    const fake = makeFakePyodide({ runPythonAsync: vi.fn().mockRejectedValue(new Error('SyntaxError')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Error ejecutando OLS en Python');
  });

  it('passes Python-side validation errors through', async () => {
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
});
