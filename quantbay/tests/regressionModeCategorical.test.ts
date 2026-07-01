import { describe, expect, it } from 'vitest';
import type { ParsedCSV } from '../src/csvParser';
import { runRegressionMode, runAutoRegressionMode } from '../src/modes/regressionMode';
import { recommendFunctionalForm } from '../src/services/formRecommender';

type Row = Record<string, unknown>;

function makeCsv(rows: Row[]): ParsedCSV {
  const headers = Object.keys(rows[0]);
  return {
    headers,
    rows,
    numericColumns: headers.filter(header => rows.every(row => typeof row[header] === 'number')),
  };
}

// ── Test 5: Y categórica bloqueada (full pipeline) ─────────────────────────────

describe('runRegressionMode — categorical Y is blocked', () => {
  const rows: Row[] = [
    { y: 'A', x: 1 },
    { y: 'B', x: 2 },
    { y: 'C', x: 3 },
  ];

  it('throws a clear error instead of silently dropping all rows', () => {
    expect(() => runRegressionMode(makeCsv(rows), 'y', ['x'], undefined))
      .toThrow(/variable dependiente Y debe ser numérica/);
  });

  it('also blocks the auto-repair entry point', () => {
    expect(() => runAutoRegressionMode(makeCsv(rows), 'y', ['x'], undefined))
      .toThrow(/variable dependiente Y debe ser numérica/);
  });
});

// ── Test 6: regression with a dummy captures the group effect ─────────────────

describe('runRegressionMode — categorical X produces a dummy with the expected effect', () => {
  const rows: Row[] = [
    { y: 10, x: 1, sector: 'A' },
    { y: 12, x: 2, sector: 'A' },
    { y: 20, x: 1, sector: 'B' },
    { y: 22, x: 2, sector: 'B' },
  ];

  it('estimates y ~ x + sector_B with sector_B capturing the B-vs-A gap', () => {
    const output = runRegressionMode(makeCsv(rows), 'y', ['x', 'sector'], undefined);

    expect(output.result.featureNames).toEqual(['x', 'sector_B']);
    expect(output.result.intercept).toBeCloseTo(8, 6);
    expect(output.result.coefficients[0]).toBeCloseTo(2, 6); // x
    expect(output.result.coefficients[1]).toBeCloseTo(10, 6); // sector_B: B is 10 above A at any x
    expect(output.result.rSquared).toBeCloseTo(1, 6);
  });

  it('reports the categorical variable in categoricalInfo with base category A', () => {
    const output = runRegressionMode(makeCsv(rows), 'y', ['x', 'sector'], undefined);
    expect(output.categoricalInfo).toHaveLength(1);
    expect(output.categoricalInfo[0]).toMatchObject({
      originalName: 'sector',
      baseCategory: 'A',
      createdDummies: ['sector_B'],
    });
    expect(output.categoricalWarnings).toEqual([]);
  });
});

// ── Test 4: dummies never receive the log transform ────────────────────────────

describe('runRegressionMode — dummies are excluded from log-X transforms', () => {
  const rows: Row[] = [
    { y: 10, x: 1, sector: 'A' },
    { y: 20, x: 2, sector: 'A' },
    { y: 30, x: 3, sector: 'B' },
    { y: 40, x: 4, sector: 'B' },
    { y: 50, x: 5, sector: 'C' },
    { y: 60, x: 6, sector: 'C' },
  ];

  it('log-log logs the numeric X but leaves dummy columns as ln-free 0/1 features', () => {
    const output = runRegressionMode(makeCsv(rows), 'y', ['x', 'sector'], undefined, 'log-log');
    expect(output.result.featureNames).toEqual(['ln(x)', 'sector_B', 'sector_C']);
    // ln(y) equation, not ln of the dummies
    expect(output.result.equation).toContain('ln(y)');
    expect(output.result.equation).not.toContain('ln(sector');
  });

  it('lin-log logs the numeric X but leaves dummy columns untouched', () => {
    const output = runRegressionMode(makeCsv(rows), 'y', ['x', 'sector'], undefined, 'lin-log');
    expect(output.result.featureNames).toEqual(['ln(x)', 'sector_B', 'sector_C']);
    expect(output.result.equation).not.toContain('ln(sector');
  });

  it('does not throw despite dummy columns containing zeros (the pre-fix failure mode)', () => {
    expect(() => runRegressionMode(makeCsv(rows), 'y', ['x', 'sector'], undefined, 'log-log')).not.toThrow();
  });
});

// ── Mixed numeric + categorical X, using the spec's worked example ────────────

describe('runRegressionMode — mixed numeric and categorical X (spec example)', () => {
  // experiencia deliberately does NOT track educacion linearly (spec's own
  // 1:1 example data is perfectly collinear and would be rejected by the
  // pre-existing collinearity guard — unrelated to categorical encoding).
  const rows: Row[] = [
    { salario: 1000, educacion: 12, experiencia: 2, sector: 'Comercio' },
    { salario: 1100, educacion: 13, experiencia: 4, sector: 'Comercio' },
    { salario: 1400, educacion: 14, experiencia: 2, sector: 'Finanzas' },
    { salario: 1500, educacion: 15, experiencia: 6, sector: 'Finanzas' },
    { salario: 1700, educacion: 16, experiencia: 3, sector: 'Tecnologia' },
    { salario: 1800, educacion: 17, experiencia: 8, sector: 'Tecnologia' },
  ];

  it('expands sector into sector_Finanzas and sector_Tecnologia with Comercio as base', () => {
    const output = runRegressionMode(makeCsv(rows), 'salario', ['educacion', 'experiencia', 'sector'], undefined);
    expect(output.result.featureNames).toEqual(['educacion', 'experiencia', 'sector_Finanzas', 'sector_Tecnologia']);
    expect(output.categoricalInfo[0].baseCategory).toBe('Comercio');
    expect(output.categoricalInfo[0].createdDummies).toEqual(['sector_Finanzas', 'sector_Tecnologia']);
  });

  it('runs through runAutoRegressionMode without crashing', () => {
    const output = runAutoRegressionMode(makeCsv(rows), 'salario', ['educacion', 'experiencia', 'sector'], undefined);
    expect(output.result.nObs).toBeGreaterThan(0);
    expect(output.categoricalInfo.length).toBeGreaterThanOrEqual(0);
  });
});

// ── formRecommender stays functional with categorical X ───────────────────────

describe('recommendFunctionalForm — categorical X does not break the recommendation', () => {
  const rows: Row[] = [
    { y: 10, x: 1, sector: 'A' },
    { y: 20, x: 2, sector: 'A' },
    { y: 30, x: 3, sector: 'B' },
    { y: 40, x: 4, sector: 'B' },
    { y: 50, x: 5, sector: 'C' },
    { y: 60, x: 6, sector: 'C' },
  ];

  it('returns a recommendation instead of failing on the dummy 0s', () => {
    const rec = recommendFunctionalForm(makeCsv(rows), 'y', ['x', 'sector']);
    expect(rec.recommended).not.toBeNull();
  });

  it('does not mark lin-log/log-log invalid solely because dummy columns contain zeros', () => {
    const rec = recommendFunctionalForm(makeCsv(rows), 'y', ['x', 'sector']);
    const linLog = rec.candidates.find(c => c.form === 'lin-log')!;
    const logLog = rec.candidates.find(c => c.form === 'log-log')!;
    expect(linLog.valid).toBe(true);
    expect(logLog.valid).toBe(true);
  });

  it('throws via assertNumericY when Y is categorical (propagates to caller)', () => {
    const badRows: Row[] = [{ y: 'A', x: 1 }, { y: 'B', x: 2 }, { y: 'C', x: 3 }];
    expect(() => recommendFunctionalForm(makeCsv(badRows), 'y', ['x']))
      .toThrow(/variable dependiente Y debe ser numérica/);
  });
});
