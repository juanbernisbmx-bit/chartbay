import { describe, expect, it } from 'vitest';
import {
  AGRO_DATA_CATALOG,
  getAgroDataSourceById,
  getAgroDataSourcesByModelType,
} from '../../src/verticals/agro/agroDataCatalog';

describe('AGRO_DATA_CATALOG', () => {
  it('incluye las 3 fuentes mínimas requeridas', () => {
    const ids = AGRO_DATA_CATALOG.map(s => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'estimaciones-agricolas-argentina',
        'precios-fob-granos-argentina',
        'faostat',
      ])
    );
  });

  it('cada fuente tiene granularidad, variables y carga manual', () => {
    for (const source of AGRO_DATA_CATALOG) {
      expect(source.granularity.length).toBeGreaterThan(0);
      expect(source.variables.length).toBeGreaterThan(0);
      expect(source.recommendedFor.length).toBeGreaterThan(0);
      expect(source.loadMethod).toBe('manual_csv');
      expect(source.notes.length).toBeGreaterThan(0);
    }
  });

  it('no incluye URLs (evita enlaces no verificados en el código)', () => {
    for (const source of AGRO_DATA_CATALOG) {
      expect(JSON.stringify(source)).not.toMatch(/https?:\/\//);
    }
  });
});

describe('getAgroDataSourcesByModelType', () => {
  it('devuelve fuentes de rinde para "yield"', () => {
    const sources = getAgroDataSourcesByModelType('yield');
    expect(sources.map(s => s.id)).toContain('estimaciones-agricolas-argentina');
  });

  it('devuelve fuentes de precio para "price"', () => {
    const sources = getAgroDataSourcesByModelType('price');
    expect(sources.map(s => s.id)).toContain('precios-fob-granos-argentina');
  });

  it('devuelve array vacío para un tipo sin fuentes recomendadas', () => {
    expect(getAgroDataSourcesByModelType('margin')).toEqual([]);
  });
});

describe('getAgroDataSourceById', () => {
  it('encuentra una fuente existente', () => {
    expect(getAgroDataSourceById('faostat')?.provider).toContain('FAO');
  });

  it('devuelve undefined si no existe', () => {
    expect(getAgroDataSourceById('no-existe')).toBeUndefined();
  });
});
