import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PyodideInterface } from '../../src/pro/pyodide/pyodideTypes';

const mocks = vi.hoisted(() => ({
  getPyodide: vi.fn(),
}));

vi.mock('../../src/pro/pyodide/pyodideLoader', () => ({
  getPyodide: mocks.getPyodide,
}));

import { runPyodideOls, buildEncodedCsvText } from '../../src/pro/pyodide/pythonOlsRunner';

const CSV = 'y,x\n3,1\n5,2\n7,3\n9,4\n11,5\n';

const VALID_STATSMODELS_PAYLOAD = {
  ok: true,
  engine: 'pyodide',
  functionalForm: 'lin-lin',
  yName: 'y',
  xNames: ['x'],
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
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' }, phase => phases.push(phase));

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
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_functional_form', 'lin-lin');
  });

  it.each(['lin-lin', 'log-lin', 'lin-log', 'log-log'] as const)(
    'passes the %s functional form through to the Python globals and back in the result',
    async form => {
      const fake = makeFakePyodide({
        runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify({ ...VALID_STATSMODELS_PAYLOAD, functionalForm: form })),
      });
      mocks.getPyodide.mockResolvedValue(fake);

      const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form });

      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_functional_form', form);
      expect(result.ok).toBe(true);
      expect(result.functionalForm).toBe(form);
    }
  );

  it('sends a Python script that uses statsmodels OLS', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('import statsmodels.api as sm');
    expect(script).toContain('sm.OLS(y, X).fit()');
    expect(script).toContain('sm.add_constant');
  });

  it('the Python script nulls out the F-stat when Y is (near) constant, since it can never be negative', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('f_stat < 0');
    expect(script).toContain('r_squared is None');
  });

  it('the Python script computes Breusch-Pagan on the effectively estimated model, after the OLS fit', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('from statsmodels.stats.diagnostic import het_breuschpagan');
    expect(script).toContain('het_breuschpagan(results.resid, results.model.exog)');
    expect(script).toContain('"rejectAt5": bp_reject');
    expect(script.indexOf('results = sm.OLS(y, X).fit()')).toBeLessThan(script.indexOf('het_breuschpagan('));
  });

  it('the Python script derives the Breusch-Pagan conclusion from the F p-value at the 5% threshold', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('bp_reject = bp_f_pvalue < 0.05');
    expect(script).toContain('Se rechaza homocedasticidad al 5%');
    expect(script).toContain('No se rechaza homocedasticidad al 5%');
  });

  it('the Python script never aborts the whole OLS result when Breusch-Pagan fails, and warns instead', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('except Exception as exc:\n        breusch_pagan = None');
    expect(script).toContain('No se pudo calcular Breusch-Pagan');
  });

  it('threads a Breusch-Pagan payload from Python straight through to the normalized result', async () => {
    const bp = {
      lmStatistic: 8.2,
      lmPValue: 0.017,
      fStatistic: 9.4,
      fPValue: 0.032,
      rejectAt5: true,
      interpretation: 'Se rechaza homocedasticidad al 5% (evidencia de heterocedasticidad).',
    };
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify({ ...VALID_STATSMODELS_PAYLOAD, breuschPagan: bp })),
    });
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    expect(result.ok).toBe(true);
    expect(result.breuschPagan).toEqual(bp);
  });

  it('sends an empty RLS constraint global when no restriction is active', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_rls_constraint_json', '');
  });

  it('serializes the RLS constraint (R, q, label) as JSON for the Python globals', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(
        JSON.stringify({
          ...VALID_STATSMODELS_PAYLOAD,
          rlsTest: { label: 'beta1 = 0', fStat: 0.5, fPValue: 0.6, dfNum: 1, dfDenom: 3, reject: false },
        })
      ),
    });
    mocks.getPyodide.mockResolvedValue(fake);

    const rlsConstraint = { R: [[0, 1]], q: [0], label: 'beta1 = 0' };
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin', rlsConstraint });

    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_rls_constraint_json', JSON.stringify(rlsConstraint));
    expect(result.ok).toBe(true);
    expect(result.rlsTest).toEqual({ label: 'beta1 = 0', fStat: 0.5, fPValue: 0.6, dfNum: 1, dfDenom: 3, reject: false });
  });

  it('the Python script reads the RLS constraint and runs a Wald/F test without re-estimating beta', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({
      csvText: CSV,
      yName: 'y',
      xNames: ['x'],
      form: 'lin-lin',
      rlsConstraint: { R: [[0, 1]], q: [0], label: 'beta1 = 0' },
    });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('rls_json = chartbay_rls_constraint_json');
    expect(script).toContain('results.f_test((R, q))');
    expect(script).toContain('"reject": bool(f_pvalue_rls is not None and f_pvalue_rls < 0.05)');
    // The unrestricted fit (sm.OLS(y, X).fit()) happens once, before the RLS
    // block — the restriction is only tested against it, never re-estimated.
    expect(script.indexOf('results = sm.OLS(y, X).fit()')).toBeLessThan(script.indexOf('rls_json = chartbay_rls_constraint_json'));
  });

  it('the Python script reads the functional form and validates the log domain before fitting', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'log-log' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('form = chartbay_functional_form');
    expect(script).toContain('log_y = form in ("log-lin", "log-log")');
    expect(script).toContain('log_x = form in ("lin-log", "log-log")');
    expect(script).toContain('El logaritmo natural no está definido para valores no positivos');
    expect(script).toContain('np.log(data[y_name])');
    expect(script).toContain('"ln(" + y_name + ")"');
  });

  it('returns a clear error when the CSV text is empty, without touching Pyodide', async () => {
    const result = await runPyodideOls({ csvText: '   ', yName: 'y', xNames: ['x'], form: 'lin-lin' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No hay CSV cargado');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('returns a clear error when no Y variable is selected', async () => {
    const result = await runPyodideOls({ csvText: CSV, yName: '', xNames: ['x'], form: 'lin-lin' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('variable Y');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('returns a clear error when no X variables are selected', async () => {
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: [], form: 'lin-lin' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('al menos una variable X');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('reports Pyodide load failures without throwing', async () => {
    mocks.getPyodide.mockRejectedValue(new Error('CDN caído'));
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No se pudo cargar Pyodide');
    expect(result.error).toContain('CDN caído');
  });

  it('reports package load failures mentioning statsmodels without throwing', async () => {
    const fake = makeFakePyodide({ loadPackage: vi.fn().mockRejectedValue(new Error('sin red')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('numpy/pandas/statsmodels');
  });

  it('reports Python execution failures without throwing', async () => {
    const fake = makeFakePyodide({ runPythonAsync: vi.fn().mockRejectedValue(new Error('SyntaxError')) });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });
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
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['z'], form: 'lin-lin' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Columnas faltantes en el CSV: z.');
  });

  it('usa errores estándar clásicos por defecto (sin standardErrorType)', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    expect(result.ok).toBe(true);
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_se_type', 'classic');
  });

  it('acepta classic explícito y lo pasa a Python', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin', standardErrorType: 'classic' });

    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_se_type', 'classic');
  });

  it('pasa cov_type="HC1" al script de statsmodels cuando se pide HC1', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify({ ...VALID_STATSMODELS_PAYLOAD, seType: 'HC1' })),
    });
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin', standardErrorType: 'HC1' });

    expect(result.ok).toBe(true);
    expect(result.standardErrorType).toBe('HC1');
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_se_type', 'HC1');
    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('sm.OLS(y, X).fit(cov_type=se_type)');
    expect(script).toContain('"HC1"');
  });

  it('pasa cov_type="HC3" al script de statsmodels cuando se pide HC3', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(JSON.stringify({ ...VALID_STATSMODELS_PAYLOAD, seType: 'HC3' })),
    });
    mocks.getPyodide.mockResolvedValue(fake);

    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin', standardErrorType: 'HC3' });

    expect(result.ok).toBe(true);
    expect(result.standardErrorType).toBe('HC3');
    expect(fake.globals.set).toHaveBeenCalledWith('chartbay_se_type', 'HC3');
    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('sm.OLS(y, X).fit(cov_type=se_type)');
    expect(script).toContain('"HC3"');
  });

  it('el script sigue usando fit() sin cov_type para classic', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin', standardErrorType: 'classic' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('sm.OLS(y, X).fit()');
  });

  it('rechaza un tipo de errores estándar inválido sin cargar ni ejecutar Python', async () => {
    const result = await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin', standardErrorType: 'HC2' });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Tipo de errores estándar inválido');
    expect(result.error).toContain('classic, HC1, HC3');
    expect(mocks.getPyodide).not.toHaveBeenCalled();
  });

  it('el script de Python valida se_type por su cuenta (defensa en profundidad)', async () => {
    const fake = makeFakePyodide();
    mocks.getPyodide.mockResolvedValue(fake);

    await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

    const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(script).toContain('se_type not in ("classic", "HC1", "HC3")');
    expect(script).toContain('Tipo de errores estándar no soportado');
  });

  it('passes Python-side empty-CSV errors through', async () => {
    const fake = makeFakePyodide({
      runPythonAsync: vi.fn().mockResolvedValue(
        JSON.stringify({ ok: false, engine: 'pyodide', warnings: [], error: 'El CSV no tiene filas de datos.' })
      ),
    });
    mocks.getPyodide.mockResolvedValue(fake);
    const result = await runPyodideOls({ csvText: 'y,x\n', yName: 'y', xNames: ['x'], form: 'lin-lin' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('El CSV no tiene filas de datos.');
  });

  describe('categorical dummies (dummyNames)', () => {
    it('sends an empty dummy-names global when none are passed', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

      expect(fake.globals.set).toHaveBeenCalledWith('chartbay_dummy_names_json', JSON.stringify([]));
    });

    it('serializes dummyNames as JSON for the Python globals', async () => {
      const fake = makeFakePyodide({
        runPythonAsync: vi.fn().mockResolvedValue(
          JSON.stringify({ ...VALID_STATSMODELS_PAYLOAD, xNames: ['ingreso', 'region_Norte', 'region_Sur'] })
        ),
      });
      mocks.getPyodide.mockResolvedValue(fake);

      await runPyodideOls({
        csvText: 'y,ingreso,region_Norte,region_Sur\n1,10,0,0\n2,20,1,0\n3,30,0,1\n',
        yName: 'y',
        xNames: ['ingreso', 'region_Norte', 'region_Sur'],
        dummyNames: ['region_Norte', 'region_Sur'],
        form: 'lin-lin',
      });

      expect(fake.globals.set).toHaveBeenCalledWith(
        'chartbay_dummy_names_json',
        JSON.stringify(['region_Norte', 'region_Sur'])
      );
    });

    it('the Python script never logs a column that is in dummy_names, even under a log-X form', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'log-log', dummyNames: ['x'] });

      const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(script).toContain('dummy_names = set(json.loads(chartbay_dummy_names_json))');
      expect(script).toContain('if log_x and col not in dummy_names:');
    });

    it('the Python script never runs pd.get_dummies — encoding is done entirely in TypeScript', async () => {
      const fake = makeFakePyodide();
      mocks.getPyodide.mockResolvedValue(fake);

      await runPyodideOls({ csvText: CSV, yName: 'y', xNames: ['x'], form: 'lin-lin' });

      const script = (fake.runPythonAsync as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(script).not.toContain('get_dummies');
    });
  });
});

describe('buildEncodedCsvText', () => {
  it('serializes rows for the given columns into CSV text with a header row', () => {
    const rows = [
      { y: 10, ingreso: 1000, region_Norte: 0, region_Sur: 1 },
      { y: 20, ingreso: 2000, region_Norte: 1, region_Sur: 0 },
    ];
    const csv = buildEncodedCsvText(rows, ['y', 'ingreso', 'region_Norte', 'region_Sur']);
    expect(csv).toBe('y,ingreso,region_Norte,region_Sur\n10,1000,0,1\n20,2000,1,0');
  });

  it('only includes the requested columns, in the requested order', () => {
    const rows = [{ a: 1, b: 2, c: 3 }];
    const csv = buildEncodedCsvText(rows, ['c', 'a']);
    expect(csv).toBe('c,a\n3,1');
  });

  it('serializes null/undefined as an empty field', () => {
    const rows = [{ y: 1, x: null }, { y: 2, x: undefined }];
    const csv = buildEncodedCsvText(rows, ['y', 'x']);
    expect(csv).toBe('y,x\n1,\n2,');
  });

  it('quotes values containing commas, quotes or newlines', () => {
    const rows = [{ label: 'a,b' }, { label: 'say "hi"' }, { label: 'line1\nline2' }];
    const csv = buildEncodedCsvText(rows, ['label']);
    expect(csv).toBe('label\n"a,b"\n"say ""hi"""\n"line1\nline2"');
  });
});
