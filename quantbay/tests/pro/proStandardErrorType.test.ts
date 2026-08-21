import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRO_STANDARD_ERROR_TYPE,
  PRO_STANDARD_ERROR_LABELS,
  PRO_STANDARD_ERROR_TYPES,
  getProCovarianceInfo,
  isProStandardErrorType,
} from '../../src/pro/pyodide/proResultTypes';

describe('ProStandardErrorType', () => {
  it('el default es classic', () => {
    expect(DEFAULT_PRO_STANDARD_ERROR_TYPE).toBe('classic');
    expect(isProStandardErrorType(DEFAULT_PRO_STANDARD_ERROR_TYPE)).toBe(true);
  });

  it('acepta classic', () => {
    expect(isProStandardErrorType('classic')).toBe(true);
  });

  it('acepta HC1', () => {
    expect(isProStandardErrorType('HC1')).toBe(true);
  });

  it('acepta HC3', () => {
    expect(isProStandardErrorType('HC3')).toBe(true);
  });

  it('acepta HAC', () => {
    expect(isProStandardErrorType('HAC')).toBe(true);
  });

  it('rechaza cualquier otro valor', () => {
    for (const invalid of ['HC0', 'HC2', 'hc1', 'CLASSIC', 'robust', 'hac', 'NeweyWest', '', ' HC1', null, undefined, 1, {}, ['HC1']]) {
      expect(isProStandardErrorType(invalid)).toBe(false);
    }
  });

  it('la lista de tipos permitidos es exactamente classic, HC1, HC3 y HAC', () => {
    expect(PRO_STANDARD_ERROR_TYPES).toEqual(['classic', 'HC1', 'HC3', 'HAC']);
  });

  it('cada tipo tiene una etiqueta de inferencia en español', () => {
    expect(PRO_STANDARD_ERROR_LABELS.classic).toBe('errores estándar clásicos');
    expect(PRO_STANDARD_ERROR_LABELS.HC1).toBe('errores estándar robustos HC1');
    expect(PRO_STANDARD_ERROR_LABELS.HC3).toBe('errores estándar robustos HC3');
    expect(PRO_STANDARD_ERROR_LABELS.HAC).toBe('errores estándar robustos HAC (Newey-West)');
  });

  it('sólo HAC informa el rezago, y sólo cuando se conoce', () => {
    expect(getProCovarianceInfo('HAC', 5).description).toContain('Rezagos usados: 5.');
    expect(getProCovarianceInfo('HAC', 0).description).toContain('Rezagos usados: 0.');
    // Sin rezago conocido (payload viejo) no se inventa un número.
    expect(getProCovarianceInfo('HAC').description).not.toContain('Rezagos usados');
    expect(getProCovarianceInfo('HC3', 5).description).not.toContain('Rezagos usados');
  });
});
