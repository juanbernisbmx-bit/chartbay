import { describe, expect, it } from 'vitest';
import { CHARTBAY_VERTICALS, isVerticalEnabled } from '../../src/verticals/agro/agroFeatureFlags';

describe('CHARTBAY_VERTICALS', () => {
  it('define los verticales conocidos', () => {
    expect(Object.keys(CHARTBAY_VERTICALS).sort()).toEqual(['agro', 'econometria', 'finanzas']);
  });

  it('econometría siempre está habilitada y agro está activo en el MVP', () => {
    expect(isVerticalEnabled('econometria')).toBe(true);
    expect(isVerticalEnabled('agro')).toBe(true);
    expect(isVerticalEnabled('finanzas')).toBe(false);
  });
});
