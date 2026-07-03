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

describe('checkProFunctionalDomain — categorical dummies (noLogXNames)', () => {
  it('does not reject a dummy column containing 0 under lin-log, when excluded via noLogXNames', () => {
    const csv = csvOf([{ y: 1, x: 1, sector_B: 0 }, { y: 2, x: 2, sector_B: 1 }, { y: 3, x: 3, sector_B: 0 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['x', 'sector_B'], 'lin-log', new Set(['sector_B']));
    expect(error).toBeNull();
  });

  it('does not reject a dummy column containing 0 under log-log, when excluded via noLogXNames', () => {
    const csv = csvOf([{ y: 1, x: 1, sector_B: 0 }, { y: 2, x: 2, sector_B: 1 }, { y: 3, x: 3, sector_B: 0 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['x', 'sector_B'], 'log-log', new Set(['sector_B']));
    expect(error).toBeNull();
  });

  it('still rejects a genuinely non-positive NUMERIC X even when a dummy is also present', () => {
    const csv = csvOf([{ y: 1, x: -1, sector_B: 0 }, { y: 2, x: 2, sector_B: 1 }, { y: 3, x: 3, sector_B: 0 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['x', 'sector_B'], 'lin-log', new Set(['sector_B']));
    expect(error).not.toBeNull();
    expect(error).toContain('x');
  });

  it('blocks log-X when X is purely categorical (every selected X is a dummy) instead of silently skipping the log', () => {
    const csv = csvOf([{ y: 1, sector_B: 0 }, { y: 2, sector_B: 1 }, { y: 3, sector_B: 0 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['sector_B'], 'lin-log', new Set(['sector_B']));
    expect(error).toBe('No se puede aplicar log(X) a una variable categórica. Usá lin-lin/log-lin o agregá una X numérica.');
  });

  it('blocks log-log the same way when X is purely categorical', () => {
    const csv = csvOf([{ y: 1, sector_B: 0, sector_C: 0 }, { y: 2, sector_B: 1, sector_C: 0 }, { y: 3, sector_B: 0, sector_C: 1 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['sector_B', 'sector_C'], 'log-log', new Set(['sector_B', 'sector_C']));
    expect(error).toContain('No se puede aplicar log(X) a una variable categórica');
  });

  it('does NOT block log-lin when X is purely categorical (log-lin only logs Y, never X)', () => {
    const csv = csvOf([{ y: 1, sector_B: 0 }, { y: 2, sector_B: 1 }, { y: 3, sector_B: 0 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['sector_B'], 'log-lin', new Set(['sector_B']));
    expect(error).toBeNull();
  });

  it('does NOT block log-X when at least one numeric X is present alongside dummies', () => {
    const csv = csvOf([{ y: 1, x: 1, sector_B: 0 }, { y: 2, x: 2, sector_B: 1 }, { y: 3, x: 3, sector_B: 0 }]);
    const error = checkProFunctionalDomain(csv, 'y', ['x', 'sector_B'], 'log-log', new Set(['sector_B']));
    expect(error).toBeNull();
  });
});
