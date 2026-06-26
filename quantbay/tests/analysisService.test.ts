import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  AnalysisValidationError,
  getCompleteNumericColumns,
  runQuantAnalysis,
  validateAnalysisInput,
} from '../src/services/analysisService';
import type { ParsedCSV } from '../src/csvParser';
import { fDistPValue } from '../src/statistics';

type Row = Record<string, unknown>;
const TOLERANCE = 1e-4;

function makeCsv(rows: Row[]): ParsedCSV {
  const headers = Object.keys(rows[0]);
  return {
    headers,
    rows,
    numericColumns: headers.filter(k => rows.every(r => typeof r[k] === 'number')),
  };
}

function expectValidationError(fn: () => unknown): AnalysisValidationError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisValidationError);
    return error as AnalysisValidationError;
  }
  throw new Error('Expected AnalysisValidationError');
}

function readFixtureCsv(fileName: string): ParsedCSV {
  const filePath = resolve(__dirname, '..', '..', 'datasets', fileName);
  const [headerLine, ...dataLines] = readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
  const headers = headerLine.split(',');
  const rows = dataLines.map(line => {
    const values = line.split(',');
    return Object.fromEntries(headers.map((header, index) => [header, Number(values[index])]));
  });

  return {
    headers,
    rows,
    numericColumns: headers,
  };
}

function expectClose(actual: number, expected: number): void {
  expect(actual).toBeCloseTo(expected, 4);
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(TOLERANCE);
}

function rss(residuals: number[]): number {
  return residuals.reduce((sum, residual) => sum + residual ** 2, 0);
}

function rlsBeta1EqualsValue(csv: ParsedCSV, beta1: number): { beta0: number; beta1: number; rss: number } {
  const yMinusRestrictedSlope = csv.rows.map(row => Number(row.y) - beta1 * Number(row.x));
  const beta0 = yMinusRestrictedSlope.reduce((sum, value) => sum + value, 0) / yMinusRestrictedSlope.length;
  const residuals = csv.rows.map(row => Number(row.y) - beta0 - beta1 * Number(row.x));
  return { beta0, beta1, rss: rss(residuals) };
}

function rlsBeta1EqualsBeta2(csv: ParsedCSV): { beta0: number; beta1: number; beta2: number; rss: number } {
  const rows = csv.rows.map(row => ({
    z: Number(row.x1) + Number(row.x2),
    y: Number(row.y),
  }));
  const { result } = runQuantAnalysis(makeCsv(rows), 'y', ['z']);
  return {
    beta0: result.intercept,
    beta1: result.coefficients[0],
    beta2: result.coefficients[0],
    rss: rss(result.residuals),
  };
}

function rlsBeta1PlusBeta2EqualsOne(csv: ParsedCSV): { beta0: number; beta1: number; beta2: number; rss: number } {
  const rows = csv.rows.map(row => ({
    z: Number(row.x1) - Number(row.x2),
    yAdjusted: Number(row.y) - Number(row.x2),
  }));
  const { result } = runQuantAnalysis(makeCsv(rows), 'yAdjusted', ['z']);
  const beta1 = result.coefficients[0];
  return {
    beta0: result.intercept,
    beta1,
    beta2: 1 - beta1,
    rss: rss(result.residuals),
  };
}

function restrictionFStat(rssOls: number, rssRls: number, n: number, k: number, m = 1): number {
  return ((rssRls - rssOls) / m) / (rssOls / (n - k));
}

const linearRows: Row[] = Array.from({ length: 10 }, (_, i) => ({
  x: i + 1,
  y: 2 * (i + 1) + 1,
}));

describe('getCompleteNumericColumns', () => {
  it('returns columns as arrays of numbers', () => {
    const rows: Row[] = [{ a: 1, b: 2 }, { a: 3, b: 4 }];
    expect(getCompleteNumericColumns(rows, ['a', 'b'])).toEqual([[1, 3], [2, 4]]);
  });

  it('excludes rows where any column is null', () => {
    const rows: Row[] = [{ a: 1, b: 2 }, { a: null, b: 4 }, { a: 5, b: 6 }];
    expect(getCompleteNumericColumns(rows, ['a', 'b'])).toEqual([[1, 5], [2, 6]]);
  });

  it('excludes rows where any column is Infinity', () => {
    const rows: Row[] = [{ a: 1, b: 2 }, { a: Infinity, b: 4 }, { a: 5, b: 6 }];
    expect(getCompleteNumericColumns(rows, ['a', 'b'])).toEqual([[1, 5], [2, 6]]);
  });

  it('returns empty arrays when no valid rows', () => {
    const rows: Row[] = [{ a: null }, { a: 'bad' }];
    const result = getCompleteNumericColumns(rows, ['a']);
    expect(result).toEqual([[]]);
  });
});

describe('runQuantAnalysis — basic', () => {
  const csv = makeCsv(linearRows);

  it('returns R² ≈ 1 for a perfect linear relationship', () => {
    const { result } = runQuantAnalysis(csv, 'y', ['x']);
    expect(result.rSquared).toBeCloseTo(1, 6);
  });

  it('returns a correlation matrix of correct shape', () => {
    const { corrMatrix, corrColumns } = runQuantAnalysis(csv, 'y', ['x']);
    expect(corrMatrix.length).toBe(corrColumns.length);
    expect(corrMatrix[0].length).toBe(corrColumns.length);
  });

  it('returns VIF array with length equal to number of predictors', () => {
    const { vifValues } = runQuantAnalysis(csv, 'y', ['x']);
    expect(vifValues.length).toBe(1);
  });

  it('dropped is 0 when all rows are valid', () => {
    const { dropped } = runQuantAnalysis(csv, 'y', ['x']);
    expect(dropped).toBe(0);
  });

  it('result contains F-statistic and CI', () => {
    const { result } = runQuantAnalysis(csv, 'y', ['x']);
    expect(result.fStat).toBeGreaterThan(0);
    expect(result.ci95.length).toBe(2); // intercept + 1 predictor
  });
});

describe('runQuantAnalysis — missing data', () => {
  it('fails before estimating when selected columns have missing values', () => {
    const rowsWithNull: Row[] = [...linearRows, { x: null, y: 30 }];
    const csvWithNull: ParsedCSV = {
      headers: ['x', 'y'],
      rows: rowsWithNull,
      numericColumns: ['x', 'y'],
    };
    expect(validateAnalysisInput(csvWithNull, 'y', ['x'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'missing_values', columns: ['x'], count: 1 }),
      ])
    );
    const error = expectValidationError(() => runQuantAnalysis(csvWithNull, 'y', ['x']));
    expect(error.message).toContain('No se pudo estimar el modelo');
    expect(error.message).toContain('"x" tiene 1 valor(es) faltante(s)');
    expect(error.message).toContain('Chart Bay no elimino ni modifico datos automaticamente.');
  });
});

describe('runQuantAnalysis — error cases', () => {
  it('throws when observations are insufficient for the number of predictors', () => {
    const small = makeCsv([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(() => runQuantAnalysis(small, 'y', ['x'])).toThrow(/Observaciones insuficientes/);
    expect(() => runQuantAnalysis(small, 'y', ['x'])).toThrow(/agrega datos o usa menos variables X/);
  });

  it('reports perfect pairwise collinearity before estimating', () => {
    const collinear: Row[] = Array.from({ length: 8 }, (_, i) => ({
      x1: i + 1, x2: 2 * (i + 1), y: i + 1,
    }));
    const csv = makeCsv(collinear);
    const issues = validateAnalysisInput(csv, 'y', ['x1', 'x2']);
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'collinearity',
          columns: ['x1', 'x2'],
        }),
      ])
    );
    expect(issues.find(issue => issue.type === 'collinearity')?.correlation).toBeCloseTo(1, 6);
    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x1', 'x2']));
    expect(error.message).toContain('"x1" y "x2" tienen colinealidad casi perfecta');
  });

  it('reports constant predictor columns before estimating', () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({
      x: 1,
      z: i + 1,
      y: i + 2,
    }));
    const csv = makeCsv(rows);
    expect(validateAnalysisInput(csv, 'y', ['x', 'z'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'constant_column', columns: ['x'] }),
      ])
    );
    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x', 'z']));
    expect(error.message).toContain('"x" es constante');
    expect(error.message).toContain('columna sin variacion');
  });

  it('reports duplicate predictor columns before estimating', () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) => ({
      x1: i + 1,
      x2: i + 1,
      y: i + 3,
    }));
    const csv = makeCsv(rows);
    expect(validateAnalysisInput(csv, 'y', ['x1', 'x2'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'duplicate_column', columns: ['x1', 'x2'] }),
      ])
    );
    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x1', 'x2']));
    expect(error.message).toContain('"x1" y "x2" son columnas duplicadas');
    expect(error.message).toContain('mismos valores fila por fila');
  });

  it('reports invalid numeric text before estimating', () => {
    const csv: ParsedCSV = {
      headers: ['x', 'y'],
      rows: [
        { x: 1, y: 2 },
        { x: 'not a number', y: 4 },
        { x: 3, y: 6 },
      ],
      numericColumns: ['x', 'y'],
    };
    expect(validateAnalysisInput(csv, 'y', ['x'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'invalid_numeric', columns: ['x'], count: 1 }),
      ])
    );
    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x']));
    expect(error.message).toContain('"x" tiene 1 valor(es) con texto o formato no numerico');
    expect(error.message).toContain('Revisa separadores, simbolos y celdas con texto');
  });

  it('reports near-perfect predictor collinearity before estimating', () => {
    const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
      x1: i + 1,
      x2: 100 + 2 * (i + 1) + (i === 11 ? 0.00001 : 0),
      y: i * 3 + 7,
    }));
    const csv = makeCsv(rows);
    expect(validateAnalysisInput(csv, 'y', ['x1', 'x2'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'collinearity', columns: ['x1', 'x2'] }),
      ])
    );
    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x1', 'x2']));
    expect(error.message).toContain('Elegi una de las dos o transforma las variables');
  });

  it('reports multivariate perfect collinearity before estimating', () => {
    const rows: Row[] = Array.from({ length: 12 }, (_, i) => {
      const x1 = i + 1;
      const x2 = (i % 4) + 1;
      return {
        x1,
        x2,
        x3: x1 + x2,
        y: i * 2 + 5,
      };
    });
    const csv = makeCsv(rows);
    expect(validateAnalysisInput(csv, 'y', ['x1', 'x2', 'x3'])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'collinearity', columns: ['x1', 'x2', 'x3'] }),
      ])
    );
    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x1', 'x2', 'x3']));
    expect(error.message).toContain('colinealidad perfecta o casi perfecta como conjunto');
  });

  it('does not mutate rows or remove invalid selected data automatically', () => {
    const rows: Row[] = [
      { x: 1, y: 2 },
      { x: '', y: 4 },
      { x: 'bad', y: 6 },
      { x: 4, y: 8 },
    ];
    const csv: ParsedCSV = {
      headers: ['x', 'y'],
      rows,
      numericColumns: ['x', 'y'],
    };
    const before = JSON.stringify(csv.rows);

    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x']));

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'missing_values', columns: ['x'], count: 1 }),
        expect.objectContaining({ type: 'invalid_numeric', columns: ['x'], count: 1 }),
      ])
    );
    expect(JSON.stringify(csv.rows)).toBe(before);
  });
});

describe('runQuantAnalysis - recoverable and valid cases', () => {
  it('does not block OLS for missing or invalid values in unselected columns', () => {
    const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
      x1: i + 1,
      x2: (i % 5) + 1,
      y: 10 + 2 * (i + 1) - (i % 5),
      unused: i === 2 ? '' : i === 7 ? 'bad' : i,
    }));
    const csv: ParsedCSV = {
      headers: ['x1', 'x2', 'y', 'unused'],
      rows,
      numericColumns: ['x1', 'x2', 'y'],
    };

    expect(validateAnalysisInput(csv, 'y', ['x1', 'x2'])).toEqual([]);
    const analysis = runQuantAnalysis(csv, 'y', ['x1', 'x2']);

    expect(analysis.result.nObs).toBe(rows.length);
    expect(analysis.dropped).toBe(0);
    expect(analysis.result.featureNames).toEqual(['x1', 'x2']);
  });

  it('runs OLS for a valid non-collinear model', () => {
    const rows: Row[] = Array.from({ length: 16 }, (_, i) => {
      const x1 = i + 1;
      const x2 = (i % 4) + Math.floor(i / 4);
      return {
        x1,
        x2,
        y: 5 + 1.5 * x1 - 0.7 * x2 + (i % 3) * 0.1,
      };
    });
    const csv = makeCsv(rows);

    expect(validateAnalysisInput(csv, 'y', ['x1', 'x2'])).toEqual([]);
    const analysis = runQuantAnalysis(csv, 'y', ['x1', 'x2']);

    expect(analysis.result.nObs).toBe(16);
    expect(analysis.result.coefficients).toHaveLength(2);
    expect(analysis.result.rSquared).toBeGreaterThan(0.9);
    expect(analysis.vifValues).toHaveLength(2);
  });
});

describe('runQuantAnalysis - OLS regression safety net', () => {
  it('estimates a simple valid OLS model with the expected intercept and slope', () => {
    const rows: Row[] = Array.from({ length: 8 }, (_, i) => {
      const x = i + 1;
      return { x, y: 3 + 2 * x };
    });
    const csv = makeCsv(rows);

    expect(validateAnalysisInput(csv, 'y', ['x'])).toEqual([]);
    const analysis = runQuantAnalysis(csv, 'y', ['x']);

    expect(analysis.result.yName).toBe('y');
    expect(analysis.result.featureNames).toEqual(['x']);
    expect(analysis.result.nObs).toBe(8);
    expect(analysis.result.nFeatures).toBe(1);
    expect(analysis.result.intercept).toBeCloseTo(3, 10);
    expect(analysis.result.coefficients).toEqual([expect.closeTo(2, 10)]);
    expect(analysis.result.rSquared).toBeCloseTo(1, 10);
    expect(analysis.result.predictions).toEqual(rows.map(row => expect.closeTo(Number(row.y), 10)));
  });

  it('keeps the automatic intercept in the OLS design', () => {
    const rows: Row[] = Array.from({ length: 10 }, (_, i) => {
      const x = i - 4;
      return { x, y: -7 + 1.25 * x };
    });
    const csv = makeCsv(rows);

    const { result } = runQuantAnalysis(csv, 'y', ['x']);

    expect(result.intercept).toBeCloseTo(-7, 10);
    expect(result.coefficients[0]).toBeCloseTo(1.25, 10);
    expect(result.equation).toContain('y = -7.0000');
  });

  it('uses only the selected predictors and preserves their order', () => {
    const rows: Row[] = Array.from({ length: 18 }, (_, i) => {
      const x1 = i + 1;
      const x2 = (i % 5) - 2;
      const unused = 500 - i * 13;
      return {
        x1,
        x2,
        unused,
        y: 4 + 1.5 * x1 - 0.75 * x2,
      };
    });
    const csv = makeCsv(rows);

    const { result } = runQuantAnalysis(csv, 'y', ['x2', 'x1']);

    expect(result.featureNames).toEqual(['x2', 'x1']);
    expect(result.coefficients).toHaveLength(2);
    expect(result.coefficients[0]).toBeCloseTo(-0.75, 10);
    expect(result.coefficients[1]).toBeCloseTo(1.5, 10);
    expect(result.intercept).toBeCloseTo(4, 10);
  });

  it('does not let unselected columns affect the OLS fit', () => {
    const rows: Row[] = Array.from({ length: 14 }, (_, i) => {
      const x = i + 1;
      return {
        x,
        y: 9 - 0.5 * x,
        unused_numeric: i % 2 === 0 ? 10_000 : -10_000,
        unused_text: i === 3 ? 'bad' : i === 8 ? '' : `row-${i}`,
      };
    });
    const csv: ParsedCSV = {
      headers: ['x', 'y', 'unused_numeric', 'unused_text'],
      rows,
      numericColumns: ['x', 'y', 'unused_numeric'],
    };

    expect(validateAnalysisInput(csv, 'y', ['x'])).toEqual([]);
    const { result, dropped } = runQuantAnalysis(csv, 'y', ['x']);

    expect(dropped).toBe(0);
    expect(result.featureNames).toEqual(['x']);
    expect(result.intercept).toBeCloseTo(9, 10);
    expect(result.coefficients[0]).toBeCloseTo(-0.5, 10);
    expect(result.rSquared).toBeCloseTo(1, 10);
  });

  it('does not block a valid selected dataset because of invalid unselected columns', () => {
    const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({
      x1: i + 1,
      x2: (i % 4) + Math.floor(i / 4),
      y: 2 + 0.8 * (i + 1) + 1.1 * ((i % 4) + Math.floor(i / 4)),
      rejected_candidate: i === 5 ? null : i === 7 ? 'N/A' : i + 100,
    }));
    const csv: ParsedCSV = {
      headers: ['x1', 'x2', 'y', 'rejected_candidate'],
      rows,
      numericColumns: ['x1', 'x2', 'y'],
    };

    expect(validateAnalysisInput(csv, 'y', ['x1', 'x2'])).toEqual([]);
    const analysis = runQuantAnalysis(csv, 'y', ['x1', 'x2']);

    expect(analysis.result.coefficients[0]).toBeCloseTo(0.8, 10);
    expect(analysis.result.coefficients[1]).toBeCloseTo(1.1, 10);
    expect(analysis.result.intercept).toBeCloseTo(2, 10);
  });

  it('returns a friendly message for singular design matrices', () => {
    const rows: Row[] = Array.from({ length: 12 }, (_, i) => {
      const x1 = i + 1;
      const x2 = (i % 4) + 1;
      return {
        x1,
        x2,
        x3: x1 + x2,
        y: 10 + x1 - 2 * x2,
      };
    });
    const csv = makeCsv(rows);

    const error = expectValidationError(() => runQuantAnalysis(csv, 'y', ['x1', 'x2', 'x3']));

    expect(error.message).toContain('No se pudo estimar el modelo');
    expect(error.message).toContain('colinealidad perfecta o casi perfecta como conjunto');
    expect(error.message).toContain('Chart Bay no elimino ni modifico datos automaticamente.');
  });
});

describe('runQuantAnalysis - validation datasets regression suite', () => {
  it('matches README values for OLS simple and documented RLS beta1 = 2', () => {
    const csv = readFixtureCsv('01_simple_linear.csv');
    const { result } = runQuantAnalysis(csv, 'y', ['x']);
    const rssOls = rss(result.residuals);
    const rls = rlsBeta1EqualsValue(csv, 2);
    const fStat = restrictionFStat(rssOls, rls.rss, 8, 2);
    const pValue = fDistPValue(fStat, 1, 6);

    expect(result.nObs).toBe(8);
    expect(result.featureNames).toEqual(['x']);
    expectClose(result.intercept, 1.041071);
    expectClose(result.coefficients[0], 1.996429);
    expectClose(rssOls, 0.129464);
    expectClose(rls.beta0, 1.025000);
    expectClose(rls.beta1, 2.000000);
    expectClose(rls.rss, 0.130000);
    expectClose(fStat, 0.024828);
    expectClose(pValue, 0.879966);
  });

  it('covers the requested RLS beta1 = 0 restriction on the simple linear fixture', () => {
    const csv = readFixtureCsv('01_simple_linear.csv');
    const { result } = runQuantAnalysis(csv, 'y', ['x']);
    const rssOls = rss(result.residuals);
    const rls = rlsBeta1EqualsValue(csv, 0);
    const fStat = restrictionFStat(rssOls, rls.rss, 8, 2);

    expect(result.nObs).toBe(8);
    expect(result.featureNames).toEqual(['x']);
    expectClose(rls.beta0, 10.025000);
    expectClose(rls.beta1, 0.000000);
    expectClose(rls.rss, 167.530000);
    expectClose(fStat, 7758.148966);
  });

  it('matches README values for RLS beta1 = beta2 when the restriction is approximately valid', () => {
    const csv = readFixtureCsv('02_beta1_eq_beta2_approx_valid.csv');
    const { result } = runQuantAnalysis(csv, 'y', ['x1', 'x2']);
    const rssOls = rss(result.residuals);
    const rls = rlsBeta1EqualsBeta2(csv);
    const fStat = restrictionFStat(rssOls, rls.rss, 10, 3);
    const pValue = fDistPValue(fStat, 1, 7);

    expect(result.nObs).toBe(10);
    expect(result.featureNames).toEqual(['x1', 'x2']);
    expectClose(result.intercept, 1.036750);
    expectClose(result.coefficients[0], 1.455750);
    expectClose(result.coefficients[1], 1.539750);
    expectClose(rssOls, 0.088500);
    expectClose(rls.beta0, 1.036750);
    expectClose(rls.beta1, 1.497750);
    expectClose(rls.beta2, 1.497750);
    expectClose(rls.rss, 0.106140);
    expectClose(fStat, 1.395254);
    expectClose(pValue, 0.276092);
  });

  it('matches README values for RLS beta1 = beta2 when the restriction is false', () => {
    const csv = readFixtureCsv('03_beta1_eq_beta2_false.csv');
    const { result } = runQuantAnalysis(csv, 'y', ['x1', 'x2']);
    const rssOls = rss(result.residuals);
    const rls = rlsBeta1EqualsBeta2(csv);
    const fStat = restrictionFStat(rssOls, rls.rss, 10, 3);
    const pValue = fDistPValue(fStat, 1, 7);

    expect(result.nObs).toBe(10);
    expect(result.featureNames).toEqual(['x1', 'x2']);
    expectClose(result.intercept, 2.046920);
    expectClose(result.coefficients[0], 3.031341);
    expectClose(result.coefficients[1], 0.464674);
    expectClose(rssOls, 0.070154);
    expectClose(rls.beta0, 2.046920);
    expectClose(rls.beta1, 1.748007);
    expectClose(rls.beta2, 1.748007);
    expectClose(rls.rss, 89.005154);
    expectClose(fStat, 8873.979083);
    expectClose(pValue, 0.000000000004);
  });

  it('matches README values for RLS beta1 + beta2 = 1', () => {
    const csv = readFixtureCsv('04_beta1_plus_beta2_eq_1.csv');
    const { result } = runQuantAnalysis(csv, 'y', ['x1', 'x2']);
    const rssOls = rss(result.residuals);
    const rls = rlsBeta1PlusBeta2EqualsOne(csv);
    const fStat = restrictionFStat(rssOls, rls.rss, 10, 3);
    const pValue = fDistPValue(fStat, 1, 7);

    expect(result.nObs).toBe(10);
    expect(result.featureNames).toEqual(['x1', 'x2']);
    expectClose(result.intercept, 0.516443);
    expectClose(result.coefficients[0], 0.381908);
    expectClose(result.coefficients[1], 0.616193);
    expectClose(rssOls, 0.029641);
    expectClose(rls.beta0, 0.506000);
    expectClose(rls.beta1, 0.382857);
    expectClose(rls.beta2, 0.617143);
    expectClose(rls.rss, 0.029926);
    expectClose(fStat, 0.067261);
    expectClose(pValue, 0.802829);
  });

  it('detects the singular perfect-collinearity dataset before estimating', () => {
    const csv = readFixtureCsv('05_perfect_collinearity.csv');
    const issues = validateAnalysisInput(csv, 'y', ['x1', 'x2']);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'collinearity',
          columns: ['x1', 'x2'],
        }),
      ])
    );
    expectValidationError(() => runQuantAnalysis(csv, 'y', ['x1', 'x2']));
  });
});
