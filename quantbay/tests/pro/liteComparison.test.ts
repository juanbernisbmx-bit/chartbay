import { describe, expect, it } from 'vitest';
import { buildLiteComparison } from '../../src/pro/liteComparison';
import { runRegressionMode } from '../../src/modes/regressionMode';
import type { ParsedCSV } from '../../src/csvParser';
import type { RLSConstraint } from '../../src/rls';

const csv: ParsedCSV = {
  headers: ['y', 'x'],
  rows: [
    { y: 2, x: 1 },
    { y: 4, x: 2 },
    { y: 6, x: 3 },
    { y: 8.2, x: 4 },
    { y: 9.9, x: 5 },
  ],
  numericColumns: ['y', 'x'],
};

describe('buildLiteComparison', () => {
  it('pairs Pro and Lite coefficients by name for lin-lin', () => {
    const lite = runRegressionMode(csv, 'y', ['x'], undefined, 'lin-lin');
    const proResult = {
      coefficients: [
        { name: 'Intercept', estimate: lite.result.intercept },
        { name: 'x', estimate: lite.result.coefficients[0] },
      ],
    };

    const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult);

    expect(comparison).not.toBeNull();
    expect(comparison?.rows).toHaveLength(2);
    expect(comparison?.rows.find(r => r.name === 'x')?.liteEstimate).toBeCloseTo(lite.result.coefficients[0]);
    expect(comparison?.liteNobs).toBe(lite.result.nObs);
  });

  it('pairs Pro and Lite coefficients by their ln(...)-prefixed name for log-log', () => {
    const lite = runRegressionMode(csv, 'y', ['x'], undefined, 'log-log');
    expect(lite.result.featureNames).toEqual(['ln(x)']);

    const proResult = {
      coefficients: [
        { name: 'Intercept', estimate: lite.result.intercept },
        { name: 'ln(x)', estimate: lite.result.coefficients[0] },
      ],
    };

    const comparison = buildLiteComparison(csv, 'y', ['x'], 'log-log', proResult);

    expect(comparison?.rows).toHaveLength(2);
    expect(comparison?.rows.find(r => r.name === 'ln(x)')?.liteEstimate).toBeCloseTo(lite.result.coefficients[0]);
  });

  it('never mixes forms: a log-log Pro coefficient name has nothing to match against a lin-lin Lite run', () => {
    // Pro estimated log-log (coefficient labeled "ln(x)"). If the comparison were
    // ever mistakenly built against a lin-lin Lite run instead (feature name "x",
    // no ln() prefix), nothing would match by name — this is what stops the two
    // sides from silently mixing forms.
    const proResult = { coefficients: [{ name: 'ln(x)', estimate: 2.0 }] };

    const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult);

    expect(comparison?.rows).toHaveLength(0);
  });

  describe('design-matrix mismatch (designMismatch)', () => {
    it('does not set designMismatch when coefficient names line up normally', () => {
      const lite = runRegressionMode(csv, 'y', ['x'], undefined, 'lin-lin');
      const proResult = {
        coefficients: [
          { name: 'Intercept', estimate: lite.result.intercept },
          { name: 'x', estimate: lite.result.coefficients[0] },
        ],
      };

      const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult);

      expect(comparison?.designMismatch).toBeUndefined();
    });

    it('shows the explicit skip message and suppresses rows/R²/n when nothing matches by name', () => {
      const proResult = { coefficients: [{ name: 'ln(x)', estimate: 2.0 }] };

      const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult);

      expect(comparison).not.toBeNull();
      expect(comparison?.rows).toHaveLength(0);
      expect(comparison?.liteRSquared).toBeNull();
      expect(comparison?.liteNobs).toBeNull();
      expect(comparison?.designMismatch).toBe(
        'La comparación Lite vs Pro se omitió porque los motores no construyeron la misma matriz de diseño.'
      );
    });
  });

  it('returns null when there are no Pro coefficients', () => {
    expect(buildLiteComparison(csv, 'y', ['x'], 'lin-lin', {})).toBeNull();
  });

  it('returns null instead of throwing when the Lite engine cannot run on this selection', () => {
    const badCsv: ParsedCSV = { headers: ['y'], rows: [{ y: 1 }], numericColumns: ['y'] };
    const proResult = { coefficients: [{ name: 'Intercept', estimate: 1.0 }] };
    expect(buildLiteComparison(badCsv, 'y', ['missing'], 'lin-lin', proResult)).toBeNull();
  });

  describe('RLS test comparison (never mixes restricted and unrestricted coefficients)', () => {
    const constraint: RLSConstraint = { R: [[0, 1]], q: [0], label: 'beta1 = 0' };

    it('compares the restriction test itself (Lite classical F-test vs Pro Wald F-test), leaving the coefficient rows unrestricted on both sides', () => {
      const liteUnrestricted = runRegressionMode(csv, 'y', ['x'], undefined, 'lin-lin');
      const liteRestricted = runRegressionMode(csv, 'y', ['x'], constraint, 'lin-lin');

      // Sanity check: the restriction actually moves the estimate, otherwise this
      // test wouldn't prove the coefficient comparison stayed unrestricted.
      expect(liteRestricted.result.coefficients[0]).not.toBeCloseTo(liteUnrestricted.result.coefficients[0], 5);

      const proResult = {
        coefficients: [
          { name: 'Intercept', estimate: liteUnrestricted.result.intercept },
          { name: 'x', estimate: liteUnrestricted.result.coefficients[0] },
        ],
        // Pro's own numbers from statsmodels' f_test — irrelevant to what Lite reports.
        rlsTest: { label: 'beta1 = 0', fStat: 999, fPValue: 0.5 },
      };

      const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult, constraint);

      // Coefficient rows are still the UNRESTRICTED estimate on both sides —
      // never the RLS-restricted one, even though a restriction is active.
      expect(comparison?.rows.find(r => r.name === 'x')?.liteEstimate).toBeCloseTo(liteUnrestricted.result.coefficients[0]);
      expect(comparison?.rows.find(r => r.name === 'x')?.liteEstimate).not.toBeCloseTo(liteRestricted.result.coefficients[0], 5);

      // The RLS test comparison uses Lite's actual restricted-vs-unrestricted F-test.
      expect(comparison?.rlsTest?.label).toBe('beta1 = 0');
      expect(comparison?.rlsTest?.liteFStat).toBeCloseTo(liteRestricted.result.fStatConstraint!);
      expect(comparison?.rlsTest?.litePValue).toBeCloseTo(liteRestricted.result.fPValueConstraint!);
    });

    it('leaves rlsTest undefined when no RLS constraint is active', () => {
      const proResult = { coefficients: [{ name: 'x', estimate: 2.0 }] };
      const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult);
      expect(comparison?.rlsTest).toBeUndefined();
    });

    it('leaves rlsTest undefined when Pro did not evaluate a restriction, even if one was requested', () => {
      const proResult = { coefficients: [{ name: 'x', estimate: 2.0 }] }; // no rlsTest field
      const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult, constraint);
      expect(comparison?.rlsTest).toBeUndefined();
    });

    it('does not fail the whole comparison when the Lite restricted run throws', () => {
      const invalidConstraint: RLSConstraint = { R: [[0, 1, 1]], q: [0], label: 'bad shape' };
      const proResult = {
        coefficients: [{ name: 'x', estimate: 2.0 }],
        rlsTest: { label: 'bad shape', fStat: 1, fPValue: 0.5 },
      };
      const comparison = buildLiteComparison(csv, 'y', ['x'], 'lin-lin', proResult, invalidConstraint);
      expect(comparison).not.toBeNull();
      expect(comparison?.rlsTest).toBeNull();
    });
  });
});
