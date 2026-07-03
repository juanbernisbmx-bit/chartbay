import { describe, expect, it } from 'vitest';
import { checkProCapability } from '../../src/pro/proCapability';
import type { RLSConstraint } from '../../src/rls';

// beta1 = 0, over [Intercept, x] (parameterCount = 2)
const validConstraint: RLSConstraint = { R: [[0, 1]], q: [0], label: 'beta1 = 0' };

describe('checkProCapability', () => {
  it('allows a plain run with no RLS and no invalid categorical X', () => {
    const block = checkProCapability({ rlsConstraint: undefined, invalidCategoricalNames: [], parameterCount: 2 });
    expect(block).toBeNull();
  });

  it('allows a valid RLS constraint whose shape matches the model', () => {
    const block = checkProCapability({ rlsConstraint: validConstraint, invalidCategoricalNames: [], parameterCount: 2 });
    expect(block).toBeNull();
  });

  it('allows a run with valid categorical X (dummies implemented — no longer blocked)', () => {
    // parameterCount accounts for the expanded dummy columns, not the raw
    // categorical selection — e.g. Intercept + ingreso + region_Norte + region_Sur = 4.
    const block = checkProCapability({ rlsConstraint: undefined, invalidCategoricalNames: [], parameterCount: 4 });
    expect(block).toBeNull();
  });

  it('blocks an RLS constraint with the wrong number of columns (does not match the coefficients)', () => {
    // R has 3 columns (intercept + 2 betas) but the model only has 2 parameters.
    const mismatched: RLSConstraint = { R: [[0, 1, -1]], q: [0], label: 'beta1 = beta2' };
    const block = checkProCapability({ rlsConstraint: mismatched, invalidCategoricalNames: [], parameterCount: 2 });
    expect(block).not.toBeNull();
    expect(block?.reason).toBe('rls-invalid');
    expect(block?.message).toContain('no coincide con los coeficientes estimados');
  });

  it('blocks an RLS constraint with more restrictions than parameters', () => {
    // 3 restriction rows, each with the right column count (2), but a
    // 2-parameter model can't have more than 2 independent restrictions.
    const tooMany: RLSConstraint = { R: [[0, 1], [1, 0], [0, 1]], q: [0, 0, 0], label: 'over-identified' };
    const block = checkProCapability({ rlsConstraint: tooMany, invalidCategoricalNames: [], parameterCount: 2 });
    expect(block).not.toBeNull();
    expect(block?.reason).toBe('rls-invalid');
  });

  it('blocks a non-finite value in the constraint', () => {
    const bad: RLSConstraint = { R: [[0, NaN]], q: [0], label: 'bad' };
    const block = checkProCapability({ rlsConstraint: bad, invalidCategoricalNames: [], parameterCount: 2 });
    expect(block).not.toBeNull();
    expect(block?.reason).toBe('rls-invalid');
  });

  it('blocks when a categorical X column could not be encoded into dummies', () => {
    const block = checkProCapability({ rlsConstraint: undefined, invalidCategoricalNames: ['region'], parameterCount: 2 });
    expect(block).not.toBeNull();
    expect(block?.reason).toBe('categorical-invalid');
    expect(block?.message).toContain('region');
    expect(block?.message).toContain('no tiene suficientes categorías válidas');
  });

  it('lists multiple invalid categorical columns and uses plural wording', () => {
    const block = checkProCapability({
      rlsConstraint: undefined,
      invalidCategoricalNames: ['region', 'sector'],
      parameterCount: 3,
    });
    expect(block?.message).toContain('region, sector');
    expect(block?.message).toContain('no tienen suficientes categorías válidas');
  });

  it('prioritizes the invalid-categorical block over RLS validation when both are present', () => {
    const block = checkProCapability({
      rlsConstraint: validConstraint,
      invalidCategoricalNames: ['region'],
      parameterCount: 2,
    });
    expect(block?.reason).toBe('categorical-invalid');
  });

  it('does not block on a null rlsConstraint (invalid typed input is handled upstream)', () => {
    const block = checkProCapability({ rlsConstraint: null, invalidCategoricalNames: [], parameterCount: 2 });
    expect(block).toBeNull();
  });
});
