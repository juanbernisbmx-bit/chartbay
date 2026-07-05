import { describe, expect, it } from 'vitest';
import { detectAgroColumns } from '../../src/verticals/agro/agroColumnDetection';
import {
  AGRO_MODEL_PRESETS,
  getAgroPresetById,
  suggestAgroModelPresets,
} from '../../src/verticals/agro/agroModelPresets';

function suggestFor(headers: string[]) {
  return suggestAgroModelPresets(detectAgroColumns(headers));
}

describe('AGRO_MODEL_PRESETS', () => {
  it('define los 4 presets iniciales con ids únicos', () => {
    expect(AGRO_MODEL_PRESETS.map(p => p.type)).toEqual(['yield', 'price', 'margin', 'production']);
    const ids = AGRO_MODEL_PRESETS.map(p => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getAgroPresetById encuentra presets y devuelve undefined si no existe', () => {
    expect(getAgroPresetById('agro-yield')?.type).toBe('yield');
    expect(getAgroPresetById('inexistente')).toBeUndefined();
  });
});

describe('suggestAgroModelPresets', () => {
  it('sugiere modelo de rinde con rinde + lluvia', () => {
    const suggestions = suggestFor(['rinde', 'lluvia']);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].preset.id).toBe('agro-yield');
    expect(suggestions[0].yColumn).toBe('rinde');
    expect(suggestions[0].xColumns).toEqual(['lluvia']);
    expect(suggestions[0].reason).toContain('rinde');
    expect(suggestions[0].missingRoles).toContain('temperature');
  });

  it('sugiere modelo de precio con precio + tipo_cambio', () => {
    const suggestions = suggestFor(['precio', 'tipo_cambio']);
    expect(suggestions.map(s => s.preset.id)).toContain('agro-price');
    const price = suggestions.find(s => s.preset.id === 'agro-price')!;
    expect(price.yColumn).toBe('precio');
    expect(price.xColumns).toEqual(['tipo_cambio']);
  });

  it('sugiere modelo de precio con precio local + chicago, eligiendo el local como Y', () => {
    const suggestions = suggestFor(['precio_chicago_usd_tn', 'precio_local_usd_tn']);
    const price = suggestions.find(s => s.preset.id === 'agro-price')!;
    expect(price.yColumn).toBe('precio_local_usd_tn');
    expect(price.xColumns).toEqual(['precio_chicago_usd_tn']);
  });

  it('sugiere modelo de margen con margen + costos/precio/rinde', () => {
    const suggestions = suggestFor(['margen_bruto', 'costo_total', 'precio', 'rinde']);
    const margin = suggestions.find(s => s.preset.id === 'agro-margin')!;
    expect(margin.yColumn).toBe('margen_bruto');
    expect(margin.xColumns).toEqual(expect.arrayContaining(['costo_total', 'precio', 'rinde']));
  });

  it('sugiere modelo de producción con producción + superficie/rinde', () => {
    const suggestions = suggestFor(['produccion_tn', 'superficie_sembrada', 'rinde_kg_ha']);
    const production = suggestions.find(s => s.preset.id === 'agro-production')!;
    expect(production.yColumn).toBe('produccion_tn');
    expect(production.xColumns).toEqual(
      expect.arrayContaining(['superficie_sembrada', 'rinde_kg_ha'])
    );
  });

  it('ordena por score descendente', () => {
    const suggestions = suggestFor([
      'margen', 'rinde', 'precio', 'costo', 'flete', 'alquiler', 'fertilizante', 'semilla', 'lluvia',
    ]);
    expect(suggestions.length).toBeGreaterThanOrEqual(2);
    expect(suggestions[0].preset.id).toBe('agro-margin');
    expect(suggestions[0].score).toBe(1);
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i].score).toBeLessThanOrEqual(suggestions[i - 1].score);
    }
  });

  it('no sugiere presets falsos con columnas irrelevantes', () => {
    expect(suggestFor(['nombre_cliente', 'email', 'edad'])).toEqual([]);
  });

  it('no sugiere modelo de precio si solo hay precio + campaña (falta X central)', () => {
    expect(suggestFor(['precio', 'campaña']).map(s => s.preset.id)).not.toContain('agro-price');
  });

  it('devuelve array vacío sin headers', () => {
    expect(suggestFor([])).toEqual([]);
  });

  it('lista los roles faltantes cuando el preset está incompleto', () => {
    const suggestions = suggestFor(['rinde', 'lluvia']);
    const missing = suggestions[0].missingRoles;
    expect(missing).toEqual(
      expect.arrayContaining(['temperature', 'fertilizer', 'price', 'season', 'province'])
    );
  });

  it('no lanza error si faltan columnas y no repite la Y entre las X', () => {
    const suggestions = suggestFor(['precio', 'precio_internacional']);
    const price = suggestions.find(s => s.preset.id === 'agro-price')!;
    expect(price.yColumn).toBe('precio');
    expect(price.xColumns).not.toContain('precio');
    expect(price.xColumns).toEqual(['precio_internacional']);
  });
});
