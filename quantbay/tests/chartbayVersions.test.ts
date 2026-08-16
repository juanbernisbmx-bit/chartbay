import { describe, expect, it } from 'vitest';
import { CHARTBAY_VERSIONS, getVersionConfig, validateCsvFileSize } from '../src/versioning/chartbayVersions';

describe('chartbayVersions', () => {
  it('Lite config matches spec', () => {
    const lite = getVersionConfig('lite');
    expect(lite.id).toBe('lite');
    // Subido de 2 MB tras medir el limpiador en C++/WASM: 516 MB y 7,9 M de
    // filas en 17 s con 727 MB de heap. El tope viejo se calculó para el
    // camino de PapaParse, que armaba un objeto de JS por fila.
    expect(lite.maxCsvSizeMb).toBe(100);
    expect(lite.engine).toBe('typescript');
    expect(lite.status).toBe('available');
  });

  it('Pro config matches spec', () => {
    const pro = getVersionConfig('pro');
    expect(pro.id).toBe('pro');
    expect(pro.maxCsvSizeMb).toBe(10);
    expect(pro.engine).toBe('pyodide');
    expect(pro.status).toBe('available');
    expect(pro.description).toContain('ChartBay Pro v1');
    expect(pro.description).toContain('ARIMA');
    expect(pro.description).toContain('índice temporal opcional');
  });

  it('Mega Pro config matches spec', () => {
    const megaPro = getVersionConfig('mega_pro');
    expect(megaPro.id).toBe('mega_pro');
    expect(megaPro.maxCsvSizeMb).toBe(50);
    expect(megaPro.engine).toBe('server_python');
    expect(megaPro.status).toBe('locked');
  });

  it('all three versions are defined', () => {
    expect(Object.keys(CHARTBAY_VERSIONS).sort()).toEqual(['lite', 'mega_pro', 'pro']);
  });

  describe('validateCsvFileSize', () => {
    it('accepts a file within the Lite limit', () => {
      const result = validateCsvFileSize(1 * 1024 * 1024, getVersionConfig('lite'));
      expect(result.ok).toBe(true);
    });

    it('rejects a file over the Lite limit with a clear message', () => {
      const result = validateCsvFileSize(150 * 1024 * 1024, getVersionConfig('lite'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain('100 MB');
        expect(result.message).toContain('Lite');
      }
    });

    it('acepta un archivo que el tope viejo habría rechazado', () => {
      // 50 MB: imposible antes, y ahora bien dentro de lo medido.
      expect(validateCsvFileSize(50 * 1024 * 1024, getVersionConfig('lite')).ok).toBe(true);
    });

    it('accepts a file within the Pro limit', () => {
      const result = validateCsvFileSize(8 * 1024 * 1024, getVersionConfig('pro'));
      expect(result.ok).toBe(true);
    });

    it('rejects a file over the Pro limit', () => {
      const result = validateCsvFileSize(11 * 1024 * 1024, getVersionConfig('pro'));
      expect(result.ok).toBe(false);
    });

    it('rejects a file over the Mega Pro limit', () => {
      const result = validateCsvFileSize(51 * 1024 * 1024, getVersionConfig('mega_pro'));
      expect(result.ok).toBe(false);
    });

    it('accepts a file within the Mega Pro limit', () => {
      const result = validateCsvFileSize(50 * 1024 * 1024, getVersionConfig('mega_pro'));
      expect(result.ok).toBe(true);
    });
  });
});
