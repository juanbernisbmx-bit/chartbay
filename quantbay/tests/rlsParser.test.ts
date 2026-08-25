import { describe, it, expect } from 'vitest';
import type { CategoricalVariableInfo } from '../src/categoricalEncoding';
import { parseRLSRestriction, refineCategoricalRlsError} from '../src/rlsParser';
import { runRegressionMode } from '../src/modes/regressionMode';
import { runRLS } from '../src/rls';
import type { ParsedCSV } from '../src/csvParser';
import type { RLSConstraint } from '../src/rls';

const X2 = ['x1', 'x2'];
const X3 = ['x1', 'x2', 'x3'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCsv(rows: Record<string, number>[]): ParsedCSV {
  const headers = Object.keys(rows[0]);
  return { headers, rows, numericColumns: headers };
}

// 12 obs for a 2-predictor model
const validRows = Array.from({ length: 12 }, (_, i) => ({
  x1: i + 1,
  x2: (i % 4) + Math.floor(i / 4),
  y: 4 + 1.5 * (i + 1) - 0.4 * ((i % 4) + Math.floor(i / 4)) + (i % 3) * 0.05,
}));

// ── 1. Empty input → OLS (returns empty string) ───────────────────────────────

describe('parseRLSRestriction – empty input', () => {
  it('returns empty string for blank input', () => {
    expect(parseRLSRestriction('', X2)).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(parseRLSRestriction('   ', X2)).toBe('');
  });
});

// ── 2. beta_x1 = beta_x2 ─────────────────────────────────────────────────────

describe('parseRLSRestriction – beta_x1 = beta_x2', () => {
  it('produces R=[0,1,-1] and q=[0]', () => {
    const r = parseRLSRestriction('beta_x1 = beta_x2', X2);
    expect(typeof r).not.toBe('string');
    const c = r as RLSConstraint;
    expect(c.R).toEqual([[0, 1, -1]]);
    expect(c.q).toEqual([0]);
  });

  it('label equals the original trimmed input', () => {
    const r = parseRLSRestriction('beta_x1 = beta_x2', X2) as RLSConstraint;
    expect(r.label).toBe('beta_x1 = beta_x2');
  });
});

// ── 3. beta_x1 + beta_x2 = 4 ─────────────────────────────────────────────────

describe('parseRLSRestriction – beta_x1 + beta_x2 = 4', () => {
  it('produces R=[0,1,1] and q=[4]', () => {
    const r = parseRLSRestriction('beta_x1 + beta_x2 = 4', X2);
    expect(typeof r).not.toBe('string');
    const c = r as RLSConstraint;
    expect(c.R).toEqual([[0, 1, 1]]);
    expect(c.q).toEqual([4]);
  });
});

// ── 4. beta_x3 = 0 ───────────────────────────────────────────────────────────

describe('parseRLSRestriction – beta_x3 = 0', () => {
  it('produces R=[0,0,0,1] and q=[0] for 3-variable model', () => {
    const r = parseRLSRestriction('beta_x3 = 0', X3);
    expect(typeof r).not.toBe('string');
    const c = r as RLSConstraint;
    expect(c.R).toEqual([[0, 0, 0, 1]]);
    expect(c.q).toEqual([0]);
  });
});

// ── 5. Bare variable names (no beta_ prefix) ──────────────────────────────────

describe('parseRLSRestriction – bare variable names', () => {
  it('x1 = x2 parses identically to beta_x1 = beta_x2', () => {
    const withPrefix = parseRLSRestriction('beta_x1 = beta_x2', X2) as RLSConstraint;
    const bare = parseRLSRestriction('x1 = x2', X2) as RLSConstraint;
    expect(bare.R).toEqual(withPrefix.R);
    expect(bare.q).toEqual(withPrefix.q);
  });

  it('x1 + x2 = 4 parses identically to beta_x1 + beta_x2 = 4', () => {
    const withPrefix = parseRLSRestriction('beta_x1 + beta_x2 = 4', X2) as RLSConstraint;
    const bare = parseRLSRestriction('x1 + x2 = 4', X2) as RLSConstraint;
    expect(bare.R).toEqual(withPrefix.R);
    expect(bare.q).toEqual(withPrefix.q);
  });

  it('x3 = 0 parses identically to beta_x3 = 0', () => {
    const withPrefix = parseRLSRestriction('beta_x3 = 0', X3) as RLSConstraint;
    const bare = parseRLSRestriction('x3 = 0', X3) as RLSConstraint;
    expect(bare.R).toEqual(withPrefix.R);
    expect(bare.q).toEqual(withPrefix.q);
  });
});

// ── 6. Additional valid forms ─────────────────────────────────────────────────

describe('parseRLSRestriction – additional valid forms', () => {
  it('beta_x1 - beta_x2 = 0 produces R=[0,1,-1] q=[0]', () => {
    const r = parseRLSRestriction('beta_x1 - beta_x2 = 0', X2) as RLSConstraint;
    expect(r.R).toEqual([[0, 1, -1]]);
    expect(r.q).toEqual([0]);
  });

  it('2*beta_x1 = 0 produces coefficient 2 in R', () => {
    const r = parseRLSRestriction('2*beta_x1 = 0', X2) as RLSConstraint;
    expect(r.R[0][1]).toBeCloseTo(2);
    expect(r.q).toEqual([0]);
  });

  it('handles negative right-hand side: x1 + x2 = -4', () => {
    const r = parseRLSRestriction('x1 + x2 = -4', X2) as RLSConstraint;
    expect(r.R).toEqual([[0, 1, 1]]);
    expect(r.q).toEqual([-4]);
  });

  it('works without spaces: beta_x1=beta_x2', () => {
    const r = parseRLSRestriction('beta_x1=beta_x2', X2) as RLSConstraint;
    expect(r.R).toEqual([[0, 1, -1]]);
    expect(r.q).toEqual([0]);
  });
});

// ── 7. Invalid variable name → clear error string ─────────────────────────────

describe('parseRLSRestriction – invalid variable name', () => {
  it('returns an error string for a variable not in xNames', () => {
    const r = parseRLSRestriction('beta_z9 = 0', X2);
    expect(typeof r).toBe('string');
    expect(r as string).toMatch(/z9/);
    expect(r as string).toMatch(/regresores|X seleccionados/i);
  });

  it('mentions the available variables in the error', () => {
    const r = parseRLSRestriction('z_unknown = 0', X2) as string;
    expect(r).toMatch(/x1|x2/);
  });
});

// ── 8. Malformed restriction → clear error string ─────────────────────────────

describe('parseRLSRestriction – malformed input', () => {
  it('rejects input with no = sign', () => {
    const r = parseRLSRestriction('beta_x1 beta_x2', X2);
    expect(typeof r).toBe('string');
    expect(r as string).toMatch(/=/);
  });

  it('rejects input with multiple = signs', () => {
    const r = parseRLSRestriction('x1 = x2 = 0', X2);
    expect(typeof r).toBe('string');
    expect(r as string).toMatch(/=/);
  });

  it('rejects empty left-hand side', () => {
    const r = parseRLSRestriction('= 0', X2);
    expect(typeof r).toBe('string');
  });

  it('rejects empty right-hand side', () => {
    const r = parseRLSRestriction('x1 =', X2);
    expect(typeof r).toBe('string');
  });

  it('rejects unrecognised tokens like "!!! = 0"', () => {
    const r = parseRLSRestriction('!!! = 0', X2);
    expect(typeof r).toBe('string');
  });

  it('rejects trivial self-equality x1 = x1', () => {
    const r = parseRLSRestriction('x1 = x1', X2);
    expect(typeof r).toBe('string');
    expect(r as string).toMatch(/trivial/i);
  });

  it('rejects intercept restriction (beta0 on neither side)', () => {
    // User would need to write "1 = 0" or similar to hit intercept slot;
    // a number on LHS accumulates into q, not R, so this becomes trivial or valid.
    // Explicit intercept restriction test: the user can't directly name "beta0"
    // because it's not in xNames — the slot is protected by resolveVar returning null.
    const r = parseRLSRestriction('beta_nonexistent = 0', X2) as string;
    expect(typeof r).toBe('string');
    expect(r).toMatch(/regresores|X seleccionados/i);
  });
});

// ── 9. Integration: parsed restriction triggers method === "RLS" ──────────────

describe('parseRLSRestriction → runRegressionMode integration', () => {
  it('parsed "x1 = x2" passed to runRegressionMode produces method RLS', () => {
    const parsed = parseRLSRestriction('x1 = x2', X2);
    expect(typeof parsed).not.toBe('string');
    const out = runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], parsed as RLSConstraint);
    expect(out.method).toBe('RLS');
    expect(out.result.method).toBe('RLS');
  });

  it('parsed "x1 + x2 = 4" satisfies the constraint exactly', () => {
    const parsed = parseRLSRestriction('x1 + x2 = 4', X2) as RLSConstraint;
    const out = runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], parsed);
    const sum = out.result.coefficients[0] + out.result.coefficients[1];
    expect(sum).toBeCloseTo(4, 8);
  });

  it('empty input → undefined constraint → OLS result', () => {
    const parsed = parseRLSRestriction('', X2);
    expect(parsed).toBe('');
    const out = runRegressionMode(makeCsv(validRows), 'y', ['x1', 'x2'], undefined);
    expect(out.method).toBe('OLS');
  });
});

// ── 10. RLS output panel: rendered result carries RLS method ──────────────────

describe('parseRLSRestriction → runRLS: result carries method RLS', () => {
  it('result from parsed typed restriction has method RLS and correct panel data', () => {
    const twoX = [[1,3],[2,1],[3,4],[4,2],[5,5],[6,1],[7,3],[8,2],[9,4],[10,1]];
    const twoY = twoX.map(([a,b]) => 1 + 0.3*a + 0.7*b + (b%2)*0.03);

    const parsed = parseRLSRestriction('x1 + x2 = 1', X2) as RLSConstraint;
    const result = runRLS(
      { X: twoX, y: twoY, featureNames: ['x1', 'x2'], yName: 'y' },
      parsed,
    );

    expect(result.method).toBe('RLS');
    expect(result.rlsConstraint).toBe('x1 + x2 = 1');
    expect(result.rssOLS).toBeGreaterThan(0);
    expect(typeof result.fStatConstraint).toBe('number');
    expect(typeof result.fPValueConstraint).toBe('number');
  });
});

// ── 11. Guided demos: existing constraint shapes still parse cleanly ───────────

describe('existing demo constraints still valid via parser', () => {
  it('beta1 = 0 shape matches manual parse of "x = 0"', () => {
    // demo uses { R: [[0, 1]], q: [0] } for single-predictor model
    const parsed = parseRLSRestriction('x = 0', ['x']) as RLSConstraint;
    expect(parsed.R).toEqual([[0, 1]]);
    expect(parsed.q).toEqual([0]);
  });

  it('beta1 = beta2 shape matches manual parse of "x1 = x2"', () => {
    const parsed = parseRLSRestriction('x1 = x2', X2) as RLSConstraint;
    expect(parsed.R).toEqual([[0, 1, -1]]);
    expect(parsed.q).toEqual([0]);
  });

  it('beta1 + beta2 = 1 shape matches manual parse of "x1 + x2 = 1"', () => {
    const parsed = parseRLSRestriction('x1 + x2 = 1', X2) as RLSConstraint;
    expect(parsed.R).toEqual([[0, 1, 1]]);
    expect(parsed.q).toEqual([1]);
  });
});

describe('restricciones RLS sobre variables categóricas', () => {
  const info: CategoricalVariableInfo[] = [{
    originalName: 'sector',
    baseCategory: 'informal',
    createdDummies: ['sector_privado', 'sector_publico'],
    categories: ['informal', 'privado', 'publico'],
  }];
  const expandidos = ['educacion', 'experiencia', 'sector_privado', 'sector_publico'];

  it('se parsea contra los nombres post-dummy, no contra la selección cruda', () => {
    // El modelo estima sector_privado y sector_publico, no "sector". Parsear
    // contra la selección cruda armaba una R con una columna de menos por cada
    // dummy extra, y la estimación moría con un error de dimensiones.
    const crudos = ['educacion', 'experiencia', 'sector'];
    const conCrudos = parseRLSRestriction('beta_educacion = beta_experiencia', crudos);
    const conExpandidos = parseRLSRestriction('beta_educacion = beta_experiencia', expandidos);

    expect(typeof conCrudos).not.toBe('string');
    expect(typeof conExpandidos).not.toBe('string');
    // Una columna por parámetro: [intercepto] + regresoras.
    expect((conCrudos as RLSConstraint).R[0].length).toBe(crudos.length + 1);
    expect((conExpandidos as RLSConstraint).R[0].length).toBe(expandidos.length + 1);
    expect((conCrudos as RLSConstraint).R[0].length).not.toBe(
      (conExpandidos as RLSConstraint).R[0].length
    );
  });

  it('acepta una dummy que existe', () => {
    expect(typeof parseRLSRestriction('beta_sector_publico = 0', expandidos)).not.toBe('string');
  });

  it('explica la categoría base, con y sin el prefijo beta_', () => {
    // El panel propone la forma con prefijo primero, así que reconocer sólo la
    // forma sin prefijo dejaba esta explicación fuera del alcance de casi todos.
    for (const texto of ['sector_informal = 0', 'beta_sector_informal = 0']) {
      const error = parseRLSRestriction(texto, expandidos) as string;
      expect(typeof error).toBe('string');
      const refinado = refineCategoricalRlsError(error, info);
      expect(refinado).toContain('categoría base');
      expect(refinado).toContain('sector_privado, sector_publico');
    }
  });

  it('explica que la categórica se reemplazó por sus dummies, con y sin prefijo', () => {
    for (const texto of ['sector = 0', 'beta_sector = 0']) {
      const error = parseRLSRestriction(texto, expandidos) as string;
      const refinado = refineCategoricalRlsError(error, info);
      expect(refinado).toContain('fue reemplazada por sus dummies');
    }
  });

  it('no toca los mensajes que no son de categóricas', () => {
    const error = parseRLSRestriction('beta_inexistente = 0', expandidos) as string;
    expect(refineCategoricalRlsError(error, info)).toBe(error);
  });
});
