import { describe, expect, it } from 'vitest';
import {
  assertNumericY,
  detectCategoricalColumns,
  dummyBaseName,
  encodeCategoricalX,
  isCategoricalColumn,
} from '../src/categoricalEncoding';

type Row = Record<string, unknown>;

// ── Test 1: basic categorical encoding (from spec) ────────────────────────────

describe('encodeCategoricalX — basic case', () => {
  const rows: Row[] = [
    { y: 10, x: 1, sector: 'A' },
    { y: 20, x: 2, sector: 'B' },
    { y: 30, x: 3, sector: 'A' },
    { y: 40, x: 4, sector: 'C' },
  ];

  it('creates k-1 dummies with the alphabetically-first category as base', () => {
    const result = encodeCategoricalX(rows, ['x', 'sector']);
    expect(result.expandedXNames).toEqual(['x', 'sector_B', 'sector_C']);
    expect(result.categoricalInfo).toHaveLength(1);
    expect(result.categoricalInfo[0]).toMatchObject({
      originalName: 'sector',
      baseCategory: 'A',
      createdDummies: ['sector_B', 'sector_C'],
      categories: ['A', 'B', 'C'],
    });
    expect(result.warnings).toEqual([]);
  });

  it('encodes each row as 0/1 against the base category', () => {
    const result = encodeCategoricalX(rows, ['x', 'sector']);
    expect(result.rows.map(r => [r.sector_B, r.sector_C])).toEqual([
      [0, 0], // A
      [1, 0], // B
      [0, 0], // A
      [0, 1], // C
    ]);
  });

  it('leaves numeric X columns untouched', () => {
    const result = encodeCategoricalX(rows, ['x', 'sector']);
    expect(result.rows.map(r => r.x)).toEqual([1, 2, 3, 4]);
  });

  it('does not mutate the input rows', () => {
    const original = rows.map(r => ({ ...r }));
    encodeCategoricalX(rows, ['x', 'sector']);
    expect(rows).toEqual(original);
  });
});

// ── Test 2: dummy-trap avoidance generalizes to k categories ──────────────────

describe('encodeCategoricalX — dummy trap avoidance', () => {
  it('creates exactly k-1 dummies for k categories', () => {
    const categories = ['A', 'B', 'C', 'D', 'E'];
    const rows: Row[] = categories.map((c, i) => ({ y: i, group: c }));
    const result = encodeCategoricalX(rows, ['group']);
    expect(result.categoricalInfo[0].createdDummies).toHaveLength(categories.length - 1);
    expect(result.expandedXNames).toHaveLength(categories.length - 1);
  });
});

// ── Test 3: single category → no dummies, warning only ────────────────────────

describe('encodeCategoricalX — single category', () => {
  const rows: Row[] = [
    { y: 10, x: 1, sector: 'A' },
    { y: 20, x: 2, sector: 'A' },
    { y: 30, x: 3, sector: 'A' },
  ];

  it('creates no dummies and drops the variable from expandedXNames', () => {
    const result = encodeCategoricalX(rows, ['x', 'sector']);
    expect(result.expandedXNames).toEqual(['x']);
    expect(result.categoricalInfo).toEqual([]);
  });

  it('surfaces a clear warning', () => {
    const result = encodeCategoricalX(rows, ['x', 'sector']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('sector');
    expect(result.warnings[0]).toContain('una sola categoría');
  });
});

// ── Test 5: categorical Y is blocked ───────────────────────────────────────────

describe('assertNumericY', () => {
  it('throws a clear error when Y is categorical', () => {
    const rows: Row[] = [
      { y: 'A', x: 1 },
      { y: 'B', x: 2 },
      { y: 'C', x: 3 },
    ];
    expect(() => assertNumericY(rows, 'y')).toThrow(/variable dependiente Y debe ser numérica/);
  });

  it('does not throw when Y is numeric', () => {
    const rows: Row[] = [{ y: 1, x: 1 }, { y: 2, x: 2 }];
    expect(() => assertNumericY(rows, 'y')).not.toThrow();
  });

  it('ignores missing values when judging numeric-ness', () => {
    const rows: Row[] = [{ y: 1, x: 1 }, { y: null, x: 2 }, { y: 3, x: 3 }];
    expect(() => assertNumericY(rows, 'y')).not.toThrow();
  });
});

// ── isCategoricalColumn ─────────────────────────────────────────────────────

describe('isCategoricalColumn', () => {
  it('returns false for a fully numeric column', () => {
    const rows: Row[] = [{ x: 1 }, { x: 2 }, { x: 3 }];
    expect(isCategoricalColumn(rows, 'x')).toBe(false);
  });

  it('returns true when at least one non-missing value is not numeric', () => {
    const rows: Row[] = [{ x: 1 }, { x: 'abc' }, { x: 3 }];
    expect(isCategoricalColumn(rows, 'x')).toBe(true);
  });

  it('returns false for a column that is entirely missing', () => {
    const rows: Row[] = [{ x: null }, { x: '' }, { x: undefined }];
    expect(isCategoricalColumn(rows, 'x')).toBe(false);
  });

  it('treats missing values as non-determining, not categorical', () => {
    const rows: Row[] = [{ x: 1 }, { x: null }, { x: 3 }];
    expect(isCategoricalColumn(rows, 'x')).toBe(false);
  });
});

// ── detectCategoricalColumns ─────────────────────────────────────────────────

describe('detectCategoricalColumns', () => {
  it('returns headers that are not numeric and have categorical values', () => {
    const rows: Row[] = [
      { salario: 1000, educacion: 12, sector: 'Comercio' },
      { salario: 1200, educacion: 14, sector: 'Finanzas' },
    ];
    const headers = ['salario', 'educacion', 'sector'];
    const numericColumns = ['salario', 'educacion'];
    expect(detectCategoricalColumns(rows, headers, numericColumns)).toEqual(['sector']);
  });
});

// ── Part 4: dummy name sanitization ────────────────────────────────────────────

describe('encodeCategoricalX — dummy name sanitization', () => {
  it('replaces spaces with underscores', () => {
    // "Almacenes" sorts first alphabetically so it becomes the base category,
    // forcing "Buenos Aires" to be one of the created dummies.
    const rows: Row[] = [
      { y: 1, region: 'Almacenes' },
      { y: 2, region: 'Cordoba' },
      { y: 3, region: 'Buenos Aires' },
    ];
    const result = encodeCategoricalX(rows, ['region']);
    expect(result.categoricalInfo[0].baseCategory).toBe('Almacenes');
    expect(result.categoricalInfo[0].createdDummies).toContain('region_Buenos_Aires');
  });

  it('strips diacritics', () => {
    const rows: Row[] = [
      { y: 1, sector: 'Comercio' },
      { y: 2, sector: 'Tecnología' },
    ];
    const result = encodeCategoricalX(rows, ['sector']);
    expect(result.categoricalInfo[0].createdDummies).toContain('sector_Tecnologia');
  });

  it('matches the compound-name example from spec (tipo_cliente + "Cliente premium")', () => {
    const rows: Row[] = [
      { y: 1, tipo_cliente: 'Cliente estandar' },
      { y: 2, tipo_cliente: 'Cliente premium' },
    ];
    const result = encodeCategoricalX(rows, ['tipo_cliente']);
    expect(result.categoricalInfo[0].createdDummies).toContain('tipo_cliente_Cliente_premium');
  });

  it('adds an incremental suffix when sanitized names collide', () => {
    const rows: Row[] = [
      { y: 1, sector: 'A' },
      { y: 2, sector: 'A!' },
      { y: 3, sector: 'A?' },
    ];
    const result = encodeCategoricalX(rows, ['sector']);
    // categories sorted: 'A', 'A!', 'A?' -> base 'A', dummies for 'A!' and 'A?'
    // both sanitize to 'sector_A' -> collision must be resolved with a suffix.
    const dummies = result.categoricalInfo[0].createdDummies;
    expect(new Set(dummies).size).toBe(dummies.length);
    expect(dummies).toContain('sector_A');
    expect(dummies.some(d => d === 'sector_A_2')).toBe(true);
  });
});

// ── dummyBaseName: the sanitized token a dummy would use, exposed for callers ──
// that only have a category label (Pro's RLS error messages recognize a
// restriction pointing at the omitted base category by recreating this token).

describe('dummyBaseName', () => {
  it('matches the token encodeCategoricalX actually assigns to a created dummy', () => {
    const rows = [{ y: 1, region: 'Centro' }, { y: 2, region: 'Norte' }, { y: 3, region: 'Sur' }];
    const result = encodeCategoricalX(rows, ['region']);
    expect(result.categoricalInfo[0].createdDummies).toContain(dummyBaseName('region', 'Norte'));
    expect(result.categoricalInfo[0].createdDummies).toContain(dummyBaseName('region', 'Sur'));
  });

  it('sanitizes spaces and diacritics the same way as the dummies it names', () => {
    expect(dummyBaseName('tipo_cliente', 'Cliente premium')).toBe('tipo_cliente_Cliente_premium');
    expect(dummyBaseName('sector', 'Tecnología')).toBe('sector_Tecnologia');
  });
});

// ── Part 5: many categories warning ────────────────────────────────────────────

describe('encodeCategoricalX — many categories', () => {
  it('warns without blocking when a column has more than 20 categories', () => {
    const rows: Row[] = Array.from({ length: 25 }, (_, i) => ({ y: i, sector: `cat${i}` }));
    const result = encodeCategoricalX(rows, ['sector']);
    expect(result.categoricalInfo[0].createdDummies).toHaveLength(24);
    expect(result.warnings.some(w => w.includes('muchas categorías'))).toBe(true);
  });
});

// ── Part 5: missing values become an explicit category ────────────────────────

describe('encodeCategoricalX — missing values', () => {
  it('treats empty/null/undefined as the explicit "Sin_dato" category', () => {
    const rows: Row[] = [
      { y: 1, sector: 'A' },
      { y: 2, sector: null },
      { y: 3, sector: '' },
      { y: 4, sector: 'B' },
    ];
    const result = encodeCategoricalX(rows, ['sector']);
    expect(result.categoricalInfo[0].categories).toContain('Sin_dato');
    // rows 2 and 3 (index 1,2) share the "Sin_dato" category
    const dummyName = result.categoricalInfo[0].createdDummies.find(d => d.includes('Sin_dato'));
    expect(dummyName).toBeDefined();
    if (dummyName) {
      expect(result.rows[1][dummyName]).toBe(result.rows[2][dummyName]);
    }
  });
});

// ── Mixed numeric + categorical X ──────────────────────────────────────────────

describe('encodeCategoricalX — mixed numeric and categorical X', () => {
  it('passes numeric columns through and expands categorical ones', () => {
    const rows: Row[] = [
      { salario: 1000, educacion: 12, experiencia: 2, sector: 'Comercio' },
      { salario: 1100, educacion: 13, experiencia: 3, sector: 'Comercio' },
      { salario: 1400, educacion: 14, experiencia: 4, sector: 'Finanzas' },
      { salario: 1500, educacion: 15, experiencia: 5, sector: 'Finanzas' },
      { salario: 1700, educacion: 16, experiencia: 6, sector: 'Tecnologia' },
      { salario: 1800, educacion: 17, experiencia: 7, sector: 'Tecnologia' },
    ];
    const result = encodeCategoricalX(rows, ['educacion', 'experiencia', 'sector']);
    expect(result.expandedXNames).toEqual(['educacion', 'experiencia', 'sector_Finanzas', 'sector_Tecnologia']);
    expect(result.categoricalInfo[0].baseCategory).toBe('Comercio');
  });
});
