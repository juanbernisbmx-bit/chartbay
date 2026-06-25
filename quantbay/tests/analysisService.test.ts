import { describe, it, expect } from 'vitest';
import { runQuantAnalysis, getCompleteNumericColumns } from '../src/services/analysisService';
import type { ParsedCSV } from '../src/csvParser';

type Row = Record<string, unknown>;

function makeCsv(rows: Row[]): ParsedCSV {
  const headers = Object.keys(rows[0]);
  return {
    headers,
    rows,
    numericColumns: headers.filter(k => rows.every(r => typeof r[k] === 'number')),
  };
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
  it('counts dropped rows correctly', () => {
    const rowsWithNull: Row[] = [...linearRows, { x: null, y: 30 }];
    const csvWithNull: ParsedCSV = {
      headers: ['x', 'y'],
      rows: rowsWithNull,
      numericColumns: ['x', 'y'],
    };
    const { dropped } = runQuantAnalysis(csvWithNull, 'y', ['x']);
    expect(dropped).toBe(1);
  });
});

describe('runQuantAnalysis — error cases', () => {
  it('throws when observations are insufficient for the number of predictors', () => {
    const small = makeCsv([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    expect(() => runQuantAnalysis(small, 'y', ['x'])).toThrow();
  });

  it('throws on perfect multicollinearity in predictors', () => {
    const collinear: Row[] = Array.from({ length: 8 }, (_, i) => ({
      x1: i + 1, x2: 2 * (i + 1), y: i + 1,
    }));
    const csv = makeCsv(collinear);
    expect(() => runQuantAnalysis(csv, 'y', ['x1', 'x2'])).toThrow();
  });
});
