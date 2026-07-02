import { describe, expect, it } from 'vitest';
import { checkProFunctionalDomain } from '../../src/pro/proDomainCheck';
import type { ParsedCSV } from '../../src/csvParser';

function csvOf(rows: Array<Record<string, number>>): ParsedCSV {
  const headers = Object.keys(rows[0]);
  return { headers, rows, numericColumns: headers };
}

describe('checkProFunctionalDomain', () => {
  it('returns null (valid) for lin-lin regardless of sign', () => {
    const csv = csvOf([{ y: -2, x: -1 }, { y: 4, x: 2 }, { y: 6, x: 3 }]);
    expect(checkProFunctionalDomain(csv, 'y', ['x'], 'lin-lin')).toBeNull();
  });

  it('returns null (valid) for log-lin when Y is strictly positive', () => {
    const csv = csvOf([{ y: 1, x: -1 }, { y: 2, x: 2 }, { y: 3, x: 3 }]);
    expect(checkProFunctionalDomain(csv, 'y', ['x'], 'log-lin')).toBeNull();
  });

  it('rejects log-lin when Y has a non-positive value', () => {
    const csv = csvOf([{ y: 1, x: 1 }, { y: 0, x: 2 }, { y: 3, x: 3 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['x'], 'log-lin');
    expect(error).not.toBeNull();
    expect(error).toContain('y');
    expect(error).toContain('no está definido para valores no positivos');
  });

  it('returns null (valid) for lin-log when X is strictly positive', () => {
    const csv = csvOf([{ y: -1, x: 1 }, { y: 2, x: 2 }, { y: 3, x: 3 }]);
    expect(checkProFunctionalDomain(csv, 'y', ['x'], 'lin-log')).toBeNull();
  });

  it('rejects lin-log when X has a non-positive value', () => {
    const csv = csvOf([{ y: 1, x: 1 }, { y: 2, x: -2 }, { y: 3, x: 3 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['x'], 'lin-log');
    expect(error).not.toBeNull();
    expect(error).toContain('x');
  });

  it('returns null (valid) for log-log when both Y and X are strictly positive', () => {
    const csv = csvOf([{ y: 1, x: 1 }, { y: 2, x: 2 }, { y: 3, x: 3 }]);
    expect(checkProFunctionalDomain(csv, 'y', ['x'], 'log-log')).toBeNull();
  });

  it('rejects log-log when Y is non-positive', () => {
    const csv = csvOf([{ y: -1, x: 1 }, { y: 2, x: 2 }, { y: 3, x: 3 }]);
    expect(checkProFunctionalDomain(csv, 'y', ['x'], 'log-log')).not.toBeNull();
  });

  it('rejects log-log when X is non-positive', () => {
    const csv = csvOf([{ y: 1, x: 1 }, { y: 2, x: -2 }, { y: 3, x: 3 }]);
    expect(checkProFunctionalDomain(csv, 'y', ['x'], 'log-log')).not.toBeNull();
  });
});
