import { describe, expect, it } from 'vitest';
import {
  applyFunctionalTransform,
  interpretFunctionalCoefficient,
  type FunctionalForm,
} from '../src/functionalForms';
import { runOLS } from '../src/regression';
import { loadFixture } from './fixtures/loadFixture';

// ── helpers ──────────────────────────────────────────────────────────────────

function closeTo(actual: number, expected: number, tol: number): boolean {
  return Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(expected));
}

function expectClose(actual: number, expected: number, tol = 1e-9): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(expected)));
}

function expectArrayClose(actual: number[], expected: number[], tol = 1e-9): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((v, i) => expectClose(v, expected[i], tol));
}

// ── fixtures ─────────────────────────────────────────────────────────────────

interface OLSExpected {
  params: number[];
  fitted: number[];
  residuals: number[];
  rss: number;
  rSquared: number;
  adjustedRSquared: number;
  stdErrors: number[];
  tStats: number[];
  pValues: number[];
  fStat: number;
}

interface FunctionalCase {
  form: string;
  description: string;
  data: { x?: number[]; y: number[]; x1?: number[]; x2?: number[] };
  expected: OLSExpected;
}

const fx = loadFixture<{ cases: FunctionalCase[] }>('functional_forms_statsmodels.json');

// ── Part 5A: transform unit tests ─────────────────────────────────────────────

describe('applyFunctionalTransform — lin-lin', () => {
  const y = [2.0, 4.0, 6.0];
  const X = [[1.0], [2.0], [3.0]];

  it('does not transform Y or X', () => {
    const result = applyFunctionalTransform(y, X, 'Y', ['X'], 'lin-lin');
    expect(result.y).toEqual(y);
    expect(result.X).toEqual(X);
    expect(result.yLogged).toBe(false);
    expect(result.loggedXIndices).toEqual([]);
  });

  it('keeps original variable names', () => {
    const result = applyFunctionalTransform(y, X, 'wages', ['education'], 'lin-lin');
    expect(result.yName).toBe('wages');
    expect(result.xNames).toEqual(['education']);
  });

  it('does not mutate the original arrays', () => {
    const yCopy = [...y];
    const XCopy = X.map(r => [...r]);
    applyFunctionalTransform(y, X, 'Y', ['X'], 'lin-lin');
    expect(y).toEqual(yCopy);
    expect(X).toEqual(XCopy);
  });
});

describe('applyFunctionalTransform — log-lin', () => {
  const y = [1.0, Math.E, Math.E ** 2];
  const X = [[0.0], [1.0], [2.0]];

  it('logs Y but not X', () => {
    const result = applyFunctionalTransform(y, X, 'Y', ['X'], 'log-lin');
    expect(result.yLogged).toBe(true);
    expect(result.loggedXIndices).toEqual([]);
    result.y.forEach((v, i) => expect(v).toBeCloseTo(Math.log(y[i]), 12));
    result.X.forEach((row, i) => expect(row[0]).toBe(X[i][0]));
  });

  it('prefixes yName with ln()', () => {
    const result = applyFunctionalTransform(y, X, 'wages', ['age'], 'log-lin');
    expect(result.yName).toBe('ln(wages)');
    expect(result.xNames).toEqual(['age']);
  });

  it('rejects Y <= 0', () => {
    expect(() => applyFunctionalTransform([0, 2, 3], X, 'Y', ['X'], 'log-lin'))
      .toThrow(/<=\s*0/);
    expect(() => applyFunctionalTransform([-1, 2, 3], X, 'Y', ['X'], 'log-lin'))
      .toThrow(/<=\s*0/);
  });

  it('rejects NaN in Y', () => {
    expect(() => applyFunctionalTransform([NaN, 2, 3], X, 'Y', ['X'], 'log-lin'))
      .toThrow(/no finito/i);
  });

  it('rejects Infinity in Y', () => {
    expect(() => applyFunctionalTransform([Infinity, 2, 3], X, 'Y', ['X'], 'log-lin'))
      .toThrow(/no finito/i);
  });

  it('rejects non-finite X even when X is not logged', () => {
    expect(() =>
      applyFunctionalTransform([1, 2, 3], [[NaN], [1], [2]], 'Y', ['X'], 'log-lin')
    ).toThrow(/no finito/i);
  });
});

describe('applyFunctionalTransform — lin-log', () => {
  const y = [1.0, 2.0, 3.0];
  const X = [[1.0], [Math.E], [Math.E ** 2]];

  it('logs X but not Y', () => {
    const result = applyFunctionalTransform(y, X, 'Y', ['X'], 'lin-log');
    expect(result.yLogged).toBe(false);
    expect(result.loggedXIndices).toEqual([0]);
    expect(result.y).toEqual(y);
    result.X.forEach((row, i) => expect(row[0]).toBeCloseTo(Math.log(X[i][0]), 12));
  });

  it('prefixes xNames with ln()', () => {
    const result = applyFunctionalTransform(y, X, 'consumption', ['income'], 'lin-log');
    expect(result.yName).toBe('consumption');
    expect(result.xNames).toEqual(['ln(income)']);
  });

  it('rejects X <= 0', () => {
    expect(() => applyFunctionalTransform(y, [[0]], 'Y', ['X'], 'lin-log'))
      .toThrow(/<=\s*0/);
    expect(() => applyFunctionalTransform([1], [[-5]], 'Y', ['X'], 'lin-log'))
      .toThrow(/<=\s*0/);
  });

  it('rejects NaN in X', () => {
    expect(() => applyFunctionalTransform(y, [[NaN], [2], [3]], 'Y', ['X'], 'lin-log'))
      .toThrow(/no finito/i);
  });

  it('rejects Infinity in X', () => {
    expect(() => applyFunctionalTransform(y, [[Infinity], [2], [3]], 'Y', ['X'], 'lin-log'))
      .toThrow(/no finito/i);
  });
});

describe('applyFunctionalTransform — log-log', () => {
  const y = [1.0, Math.E, Math.E ** 2];
  const X = [[1.0], [Math.E], [Math.E ** 2]];

  it('logs both Y and X', () => {
    const result = applyFunctionalTransform(y, X, 'Y', ['X'], 'log-log');
    expect(result.yLogged).toBe(true);
    expect(result.loggedXIndices).toEqual([0]);
    result.y.forEach((v, i) => expect(v).toBeCloseTo(Math.log(y[i]), 12));
    result.X.forEach((row, i) => expect(row[0]).toBeCloseTo(Math.log(X[i][0]), 12));
  });

  it('prefixes both names with ln()', () => {
    const result = applyFunctionalTransform(y, X, 'gdp', ['capital'], 'log-log');
    expect(result.yName).toBe('ln(gdp)');
    expect(result.xNames).toEqual(['ln(capital)']);
  });

  it('rejects Y <= 0', () => {
    expect(() => applyFunctionalTransform([0, 2, 3], X, 'Y', ['X'], 'log-log'))
      .toThrow(/<=\s*0/);
  });

  it('rejects X <= 0', () => {
    expect(() => applyFunctionalTransform(y, [[0], [2], [3]], 'Y', ['X'], 'log-log'))
      .toThrow(/<=\s*0/);
  });

  it('rejects NaN in Y', () => {
    expect(() => applyFunctionalTransform([NaN, 2, 3], X, 'Y', ['X'], 'log-log'))
      .toThrow(/no finito/i);
  });

  it('rejects NaN in X', () => {
    expect(() => applyFunctionalTransform(y, [[NaN], [2], [3]], 'Y', ['X'], 'log-log'))
      .toThrow(/no finito/i);
  });

  it('uses natural logarithm (base e)', () => {
    // ln(e^3) = 3  →  exact check
    const result = applyFunctionalTransform([Math.E ** 3], [[Math.E ** 5]], 'Y', ['X'], 'log-log');
    expect(result.y[0]).toBeCloseTo(3, 12);
    expect(result.X[0][0]).toBeCloseTo(5, 12);
  });

  it('does not mutate original arrays', () => {
    const yCopy = [...y];
    const XCopy = X.map(r => [...r]);
    applyFunctionalTransform(y, X, 'Y', ['X'], 'log-log');
    expect(y).toEqual(yCopy);
    expect(X).toEqual(XCopy);
  });
});

describe('applyFunctionalTransform — multi-regressor', () => {
  const y = [1.0, 2.0, 3.0, 4.0];
  const X = [[1.0, 2.0], [2.0, 3.0], [3.0, 4.0], [4.0, 5.0]];

  it('lin-log logs all X columns', () => {
    const result = applyFunctionalTransform(y, X, 'Y', ['x1', 'x2'], 'lin-log');
    expect(result.loggedXIndices).toEqual([0, 1]);
    expect(result.xNames).toEqual(['ln(x1)', 'ln(x2)']);
    result.X.forEach((row, i) => {
      expect(row[0]).toBeCloseTo(Math.log(X[i][0]), 12);
      expect(row[1]).toBeCloseTo(Math.log(X[i][1]), 12);
    });
  });
});

// ── Part 5B: statsmodels fixture validation ────────────────────────────────────

describe('Functional forms validated against committed statsmodels fixtures', () => {
  for (const testCase of fx.cases) {
    it(`${testCase.form}: ${testCase.description}`, () => {
      const form = testCase.form as FunctionalForm;
      const rawY = testCase.data.y;

      // Build raw X from fixture data (single or multi-regressor)
      let rawX: number[][];
      let xNames: string[];
      if (testCase.data.x !== undefined) {
        rawX = testCase.data.x.map(v => [v]);
        xNames = ['x'];
      } else {
        rawX = (testCase.data.x1 as number[]).map((v, i) => [v, (testCase.data.x2 as number[])[i]]);
        xNames = ['x1', 'x2'];
      }

      const { y, X, yName, xNames: txNames } = applyFunctionalTransform(rawY, rawX, 'y', xNames, form);
      const result = runOLS({ X, y, featureNames: txNames, yName });
      const params = [result.intercept, ...result.coefficients];

      expectArrayClose(params, testCase.expected.params);
      expectArrayClose(result.predictions, testCase.expected.fitted);
      expectArrayClose(result.residuals, testCase.expected.residuals);

      const rss = result.residuals.reduce((s, r) => s + r * r, 0);
      expectClose(rss, testCase.expected.rss);
      expectClose(result.rSquared, testCase.expected.rSquared);
      expectClose(result.adjustedRSquared, testCase.expected.adjustedRSquared);

      expectArrayClose(result.stdErrors, testCase.expected.stdErrors, 1e-7);
      expectArrayClose(result.tStats, testCase.expected.tStats, 1e-6);
      expectArrayClose(result.pValues, testCase.expected.pValues, 1e-6);
      expectClose(result.fStat, testCase.expected.fStat, 1e-6);
    });
  }
});

// ── Part 5C: interpretation tests ─────────────────────────────────────────────

describe('interpretFunctionalCoefficient — lin-lin', () => {
  it('returns kind=absolute', () => {
    const r = interpretFunctionalCoefficient('lin-lin', 'X', 2.5);
    expect(r.kind).toBe('absolute');
    expect(r.exactEffect).toBeNull();
  });

  it('mentions units and the coefficient value', () => {
    const r = interpretFunctionalCoefficient('lin-lin', 'education', 1.234);
    expect(r.approxRule).toMatch(/1 unidad/i);
    expect(r.approxRule).toMatch(/1\.2340/);
    expect(r.approxRule).toMatch(/educacion|education/i);
  });
});

describe('interpretFunctionalCoefficient — log-lin', () => {
  it('returns kind=semielasticity', () => {
    const r = interpretFunctionalCoefficient('log-lin', 'X', 0.05);
    expect(r.kind).toBe('semielasticity');
  });

  it('approx rule expresses percentage change', () => {
    const r = interpretFunctionalCoefficient('log-lin', 'X', 0.05);
    expect(r.approxRule).toMatch(/%/);
    // 100 * 0.05 = 5.0000 %
    expect(r.approxRule).toMatch(/5\.0000/);
  });

  it('provides exact effect = 100*(exp(beta)-1)', () => {
    const beta = 0.05;
    const r = interpretFunctionalCoefficient('log-lin', 'X', beta);
    expect(r.exactEffect).not.toBeNull();
    const exactPct = 100 * (Math.exp(beta) - 1);
    expect(r.exactEffect).toMatch(exactPct.toFixed(4));
  });

  it('exact effect differs from approx rule for large beta', () => {
    const beta = 0.5;
    const r = interpretFunctionalCoefficient('log-lin', 'X', beta);
    const approxPct = 100 * beta;                   // 50%
    const exactPct = 100 * (Math.exp(beta) - 1);   // ~64.87%
    // approx and exact should differ
    expect(Math.abs(approxPct - exactPct)).toBeGreaterThan(1);
    expect(r.exactEffect).toMatch(exactPct.toFixed(4));
  });
});

describe('interpretFunctionalCoefficient — lin-log', () => {
  it('returns kind=semielasticity-x', () => {
    const r = interpretFunctionalCoefficient('lin-log', 'X', 300);
    expect(r.kind).toBe('semielasticity-x');
    expect(r.exactEffect).toBeNull();
  });

  it('approx rule expresses beta/100 units per 1% change', () => {
    const beta = 300;
    const r = interpretFunctionalCoefficient('lin-log', 'income', beta);
    // beta/100 = 3
    expect(r.approxRule).toMatch(/3\.000000/);
    expect(r.approxRule).toMatch(/1%/);
    expect(r.approxRule).toMatch(/income/i);
  });
});

describe('interpretFunctionalCoefficient — log-log', () => {
  it('returns kind=elasticity', () => {
    const r = interpretFunctionalCoefficient('log-log', 'X', 1.2);
    expect(r.kind).toBe('elasticity');
    expect(r.exactEffect).toBeNull();
  });

  it('names the concept of elasticity', () => {
    const r = interpretFunctionalCoefficient('log-log', 'capital', 0.35);
    expect(r.approxRule).toMatch(/elasticidad|elasticity/i);
    expect(r.approxRule).toMatch(/0\.3500/);
    expect(r.approxRule).toMatch(/1%/);
  });
});

// ── Part 5D: OLS property checks after transform ──────────────────────────────

describe('OLS mathematical properties hold after functional transform', () => {
  const logLogCase = fx.cases.find(c => c.form === 'log-log' && c.data.x !== undefined)!;
  const rawY = logLogCase.data.y;
  const rawX = (logLogCase.data.x as number[]).map(v => [v]);
  const { y, X, yName, xNames } = applyFunctionalTransform(rawY, rawX, 'y', ['x'], 'log-log');
  const result = runOLS({ X, y, featureNames: xNames, yName });

  it('residuals sum to ~0 (intercept model)', () => {
    const sum = result.residuals.reduce((s, r) => s + r, 0);
    expect(Math.abs(sum)).toBeLessThan(1e-8);
  });

  it('fitted + residual = transformed y', () => {
    result.predictions.forEach((p, i) => {
      expect(Math.abs(p + result.residuals[i] - y[i])).toBeLessThan(1e-9);
    });
  });

  it('R² is in [0, 1]', () => {
    expect(result.rSquared).toBeGreaterThanOrEqual(0);
    expect(result.rSquared).toBeLessThanOrEqual(1);
  });

  it('closeTo helper matches fixture values', () => {
    expect(closeTo(result.rSquared, logLogCase.expected.rSquared, 1e-9)).toBe(true);
  });
});
