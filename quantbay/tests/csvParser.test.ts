import { describe, it, expect } from 'vitest';
import { extractColumn, extractMatrix, getValidRows } from '../src/csvParser';

type Row = Record<string, unknown>;

const baseRows: Row[] = [
  { x: 1, y: 10, label: 'a' },
  { x: 2, y: 20, label: 'b' },
  { x: 3, y: 30, label: 'c' },
];

describe('extractColumn', () => {
  it('extracts numeric values', () => {
    expect(extractColumn(baseRows, 'x')).toEqual([1, 2, 3]);
    expect(extractColumn(baseRows, 'y')).toEqual([10, 20, 30]);
  });

  it('filters NaN (null, string)', () => {
    const rows: Row[] = [{ x: 1 }, { x: null }, { x: 'abc' }, { x: 3 }];
    expect(extractColumn(rows, 'x')).toEqual([1, 3]);
  });

  it('filters Infinity values', () => {
    const rows: Row[] = [{ x: 1 }, { x: Infinity }, { x: -Infinity }, { x: 3 }];
    expect(extractColumn(rows, 'x')).toEqual([1, 3]);
  });

  it('returns empty array for all-missing column', () => {
    expect(extractColumn([{ x: null }, { x: 'a' }], 'x')).toEqual([]);
  });

  it('returns empty array for non-existent column', () => {
    expect(extractColumn(baseRows, 'z')).toEqual([]);
  });
});

describe('extractMatrix', () => {
  const rows: Row[] = [
    { a: 1, b: 2 },
    { a: 3, b: 4 },
    { a: null, b: 6 },
    { a: 5, b: 'bad' },
    { a: 7, b: 8 },
  ];

  it('keeps only fully-valid rows', () => {
    expect(extractMatrix(rows, ['a', 'b']).X).toEqual([[1, 2], [3, 4], [7, 8]]);
  });

  it('tracks correct valid indices', () => {
    expect(extractMatrix(rows, ['a', 'b']).validIndices).toEqual([0, 1, 4]);
  });

  it('returns empty matrix when no valid rows', () => {
    expect(extractMatrix([{ a: null }, { a: 'x' }], ['a']).X).toHaveLength(0);
  });

  it('single-column extraction only excludes rows where that column is invalid', () => {
    // row with a=5 and b='bad' is valid when extracting only 'a'
    expect(extractMatrix(rows, ['a']).X).toEqual([[1], [3], [5], [7]]);
  });
});

describe('getValidRows', () => {
  const rows: Row[] = [
    { y: 10, x1: 1, x2: 2 },
    { y: 20, x1: 3, x2: 4 },
    { y: null, x1: 5, x2: 6 },
    { y: 40, x1: null, x2: 8 },
    { y: 50, x1: 9, x2: 10 },
  ];

  it('filters rows where y or any x is missing', () => {
    expect(getValidRows(rows, 'y', ['x1', 'x2']).y).toEqual([10, 20, 50]);
  });

  it('X matrix has correct shape', () => {
    expect(getValidRows(rows, 'y', ['x1', 'x2']).X).toEqual([[1, 2], [3, 4], [9, 10]]);
  });

  it('dropped count is correct', () => {
    expect(getValidRows(rows, 'y', ['x1', 'x2']).dropped).toBe(2);
  });

  it('returns empty when all rows have missing values', () => {
    const bad: Row[] = [{ y: null, x: 1 }, { y: 10, x: null }];
    const { y, X, dropped } = getValidRows(bad, 'y', ['x']);
    expect(y).toHaveLength(0);
    expect(X).toHaveLength(0);
    expect(dropped).toBe(2);
  });

  it('treats Infinity as missing', () => {
    const withInf: Row[] = [{ y: 10, x: Infinity }, { y: 20, x: 3 }];
    expect(getValidRows(withInf, 'y', ['x']).y).toEqual([20]);
  });
});
