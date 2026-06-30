import { describe, it, expect } from 'vitest';
import { loadFixture } from './fixtures/loadFixture';
import { runRegressionMode } from '../src/modes/regressionMode';
import type { ParsedCSV } from '../src/csvParser';
import type { FunctionalForm } from '../src/functionalForms';

interface FormCase {
  form: FunctionalForm;
  description: string;
  data: Record<string, number[]>;
  expected: {
    params: number[];
    rSquared: number;
    adjustedRSquared: number;
    fStat: number;
    df: number;
  };
}

interface FormFixture {
  cases: FormCase[];
}

function buildCSV(data: Record<string, number[]>): { csvData: ParsedCSV; yName: string; xNames: string[] } {
  const keys = Object.keys(data);
  const yName = 'y';
  const xNames = keys.filter(k => k !== yName);
  const n = data[keys[0]].length;
  const rows = Array.from({ length: n }, (_, i) =>
    Object.fromEntries(keys.map(k => [k, data[k][i]])) as Record<string, number | null>
  );
  return {
    csvData: { headers: keys, rows, numericColumns: keys },
    yName,
    xNames,
  };
}

function relClose(a: number, e: number, tol: number): boolean {
  return Math.abs(a - e) <= tol * Math.max(1, Math.abs(e));
}

const fix = loadFixture<FormFixture>('functional_forms_statsmodels.json');

describe('runRegressionMode – functional forms (statsmodels reference)', () => {
  fix.cases.forEach(c => {
    it(`${c.description} — intercept and coefficients`, () => {
      const { csvData, yName, xNames } = buildCSV(c.data);
      const output = runRegressionMode(csvData, yName, xNames, undefined, c.form);
      const { result } = output;

      expect(output.functionalForm).toBe(c.form);

      // intercept = params[0], coefficients = params[1..]
      expect(relClose(result.intercept, c.expected.params[0], 1e-8)).toBe(true);
      xNames.forEach((_, j) => {
        expect(relClose(result.coefficients[j], c.expected.params[j + 1], 1e-8)).toBe(true);
      });
    });

    it(`${c.description} — R² and F-stat`, () => {
      const { csvData, yName, xNames } = buildCSV(c.data);
      const { result } = runRegressionMode(csvData, yName, xNames, undefined, c.form);

      expect(relClose(result.rSquared, c.expected.rSquared, 1e-7)).toBe(true);
      expect(relClose(result.adjustedRSquared, c.expected.adjustedRSquared, 1e-7)).toBe(true);
      expect(relClose(result.fStat, c.expected.fStat, 1e-6)).toBe(true);
      expect(result.df).toBe(c.expected.df);
    });
  });

  it('defaults to lin-lin when no form argument is passed', () => {
    const { csvData, yName, xNames } = buildCSV(fix.cases[0].data);
    const output = runRegressionMode(csvData, yName, xNames, undefined);
    expect(output.functionalForm).toBe('lin-lin');
  });

  it('lin-lin result matches explicit lin-lin result', () => {
    const { csvData, yName, xNames } = buildCSV(fix.cases[0].data);
    const implicit = runRegressionMode(csvData, yName, xNames, undefined);
    const explicit = runRegressionMode(csvData, yName, xNames, undefined, 'lin-lin');
    expect(implicit.result.intercept).toBe(explicit.result.intercept);
    expect(implicit.result.rSquared).toBe(explicit.result.rSquared);
  });

  it('log-lin throws on non-positive Y', () => {
    const csvData: ParsedCSV = {
      headers: ['y', 'x'],
      rows: [{ y: -1, x: 1 }, { y: 2, x: 2 }, { y: 3, x: 3 }, { y: 4, x: 4 }],
      numericColumns: ['y', 'x'],
    };
    expect(() => runRegressionMode(csvData, 'y', ['x'], undefined, 'log-lin')).toThrow();
  });

  it('lin-log throws on non-positive X', () => {
    const csvData: ParsedCSV = {
      headers: ['y', 'x'],
      rows: [{ y: 1, x: 0 }, { y: 2, x: 2 }, { y: 3, x: 3 }, { y: 4, x: 4 }],
      numericColumns: ['y', 'x'],
    };
    expect(() => runRegressionMode(csvData, 'y', ['x'], undefined, 'lin-log')).toThrow();
  });

  it('log-log throws on zero X', () => {
    const csvData: ParsedCSV = {
      headers: ['y', 'x'],
      rows: [{ y: 1, x: 0 }, { y: 2, x: 2 }, { y: 3, x: 3 }, { y: 4, x: 4 }],
      numericColumns: ['y', 'x'],
    };
    expect(() => runRegressionMode(csvData, 'y', ['x'], undefined, 'log-log')).toThrow();
  });

  it('log-log two-regressor: all three params match statsmodels', () => {
    const twoVarCase = fix.cases.find(c => c.form === 'log-log' && 'x1' in c.data)!;
    const { csvData, yName, xNames } = buildCSV(twoVarCase.data);
    const { result } = runRegressionMode(csvData, yName, xNames, undefined, 'log-log');

    expect(relClose(result.intercept, twoVarCase.expected.params[0], 1e-8)).toBe(true);
    expect(relClose(result.coefficients[0], twoVarCase.expected.params[1], 1e-8)).toBe(true);
    expect(relClose(result.coefficients[1], twoVarCase.expected.params[2], 1e-8)).toBe(true);
    expect(relClose(result.rSquared, twoVarCase.expected.rSquared, 1e-7)).toBe(true);
  });
});
