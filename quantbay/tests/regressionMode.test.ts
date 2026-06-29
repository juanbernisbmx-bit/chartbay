import { describe, expect, it } from 'vitest';
import type { ParsedCSV } from '../src/csvParser';
import { runRegressionMode, runAutoRegressionMode } from '../src/modes/regressionMode';
import type { RLSConstraint } from '../src/rls';
import { parseRLSRestriction } from '../src/rlsParser';
import { formatRegressionError } from '../src/ui/errors';

type Row = Record<string, unknown>;

function makeCsv(rows: Row[]): ParsedCSV {
  const headers = Object.keys(rows[0]);
  return {
    headers,
    rows,
    numericColumns: headers.filter(header => rows.every(row => typeof row[header] === 'number')),
  };
}

const validRows: Row[] = Array.from({ length: 12 }, (_, index) => {
  const x1 = index + 1;
  const x2 = (index % 4) + Math.floor(index / 4);
  return {
    x1,
    x2,
    y: 4 + 1.5 * x1 - 0.4 * x2 + (index % 3) * 0.05,
  };
});

describe('runRegressionMode RLS user-facing behavior', () => {
  it('returns RLS outputs when a valid demo-style restriction applies', () => {
    const constraint: RLSConstraint = { R: [[0, 1, -1]], q: [0], label: 'beta1 = beta2' };
    const output = runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], constraint);

    expect(output.method).toBe('RLS');
    expect(output.result.method).toBe('RLS');
    expect(output.result.coefficients[0]).toBeCloseTo(output.result.coefficients[1], 10);
    expect(output.result.rssOLS).toBeGreaterThan(0);
    expect(output.result.rssRLS).toBeGreaterThanOrEqual(output.result.rssOLS! - 1e-9);
    expect(output.result.fStatConstraint).toBeGreaterThanOrEqual(0);
    expect(output.result.fPValueConstraint).toBeGreaterThanOrEqual(0);
    expect(output.result.fPValueConstraint).toBeLessThanOrEqual(1);
  });

  it('rejects invalid RLS restrictions instead of silently displaying OLS', () => {
    const badConstraint: RLSConstraint = { R: [[0, 1, -1]], q: [], label: 'bad q' };

    expect(() => runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], badConstraint))
      .toThrow(/No se pudo aplicar la restricci/);

    let caught: unknown;
    try {
      runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], badConstraint);
    } catch (error) {
      caught = error;
    }
    const message = formatRegressionError(caught);
    expect(message).toContain('Sugerencia');
    expect(message).toContain('q');
  });

  it('rejects redundant and too many restrictions with clear errors', () => {
    const redundant: RLSConstraint = {
      R: [
        [0, 1, -1],
        [0, 2, -2],
      ],
      q: [0, 0],
      label: 'duplicate beta1 = beta2',
    };
    const tooMany: RLSConstraint = {
      R: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [1, 1, 1],
      ],
      q: [0, 0, 0, 0],
      label: 'too many',
    };

    expect(() => runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], redundant))
      .toThrow(/restricci|singular/i);
    expect(() => runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], tooMany))
      .toThrow(/restricciones|par/i);
  });

  it('typed restriction string (via parseRLSRestriction) triggers method RLS', () => {
    const parsed = parseRLSRestriction('x1 = x2', ['x1', 'x2']);
    expect(typeof parsed).not.toBe('string');
    const output = runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], parsed as RLSConstraint);
    expect(output.method).toBe('RLS');
    expect(output.result.method).toBe('RLS');
  });

  it('empty typed input (parseRLSRestriction returns "") → OLS', () => {
    const parsed = parseRLSRestriction('', ['x1', 'x2']);
    expect(parsed).toBe('');
    const output = runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], undefined);
    expect(output.method).toBe('OLS');
  });

  it('keeps auto-repair fallback explicit when a repaired model no longer matches the RLS restriction', () => {
    const rows = Array.from({ length: 12 }, (_, index) => {
      const x1 = index + 1;
      return { x1, x2: 2 * x1, y: 3 + x1 };
    });
    const constraint: RLSConstraint = { R: [[0, 1, -1]], q: [0], label: 'beta1 = beta2' };
    const output = runAutoRegressionMode(makeCsv(rows), 'y', ['x1', 'x2'], constraint);

    expect(output.method).toBe('OLS');
    expect(output.rlsFallbackNote).toContain('OLS');
    expect(output.rlsFallbackNote).toContain('restric');
  });
});
