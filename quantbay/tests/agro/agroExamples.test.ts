import { describe, expect, it } from 'vitest';
import {
  AGRO_EXAMPLE_DATASETS,
  MAIZ_MARGEN_DEMO,
  SOJA_RINDE_DEMO,
  TRIGO_PRECIO_DEMO,
  agroDatasetToCsv,
  getAgroExampleById,
} from '../../src/verticals/agro/agroExamples';
import { detectAgroColumns } from '../../src/verticals/agro/agroColumnDetection';
import { getAgroPresetById, suggestAgroModelPresets } from '../../src/verticals/agro/agroModelPresets';

describe('AGRO_EXAMPLE_DATASETS', () => {
  it('expone los 3 datasets de demo', () => {
    expect(AGRO_EXAMPLE_DATASETS.map(d => d.id)).toEqual([
      'soja_rinde_demo', 'maiz_margen_demo', 'trigo_precio_demo',
    ]);
  });

  it('cada dataset tiene columnas, entre 12 y 30 filas y synthetic = true', () => {
    for (const dataset of AGRO_EXAMPLE_DATASETS) {
      expect(dataset.columns.length).toBeGreaterThan(0);
      expect(dataset.rows.length).toBeGreaterThanOrEqual(12);
      expect(dataset.rows.length).toBeLessThanOrEqual(30);
      expect(dataset.synthetic).toBe(true);
      expect(dataset.description.length).toBeGreaterThan(0);
    }
  });

  it('cada fila tiene exactamente las columnas declaradas', () => {
    for (const dataset of AGRO_EXAMPLE_DATASETS) {
      for (const row of dataset.rows) {
        expect(Object.keys(row).sort()).toEqual([...dataset.columns].sort());
      }
    }
  });

  it('los presets sugeridos existen', () => {
    for (const dataset of AGRO_EXAMPLE_DATASETS) {
      expect(dataset.suggestedPresetId).toBeDefined();
      expect(getAgroPresetById(dataset.suggestedPresetId!)).toBeDefined();
    }
  });

  it('los headers son detectables por detectAgroColumns y habilitan el preset sugerido', () => {
    for (const dataset of AGRO_EXAMPLE_DATASETS) {
      const detection = detectAgroColumns(dataset.columns);
      const detected = detection.columns.filter(c => c.role !== 'unknown');
      expect(detected.length).toBeGreaterThanOrEqual(4);

      const suggestions = suggestAgroModelPresets(detection);
      expect(suggestions.map(s => s.preset.id)).toContain(dataset.suggestedPresetId);
    }
  });

  it('getAgroExampleById encuentra datasets y devuelve undefined si no existe', () => {
    expect(getAgroExampleById('soja_rinde_demo')?.crop).toBe('soja');
    expect(getAgroExampleById('no_existe')).toBeUndefined();
  });
});

describe('coherencia interna de los datos sintéticos', () => {
  it('soja: produccion_tn = rinde_kg_ha × superficie_sembrada_ha / 1000', () => {
    for (const row of SOJA_RINDE_DEMO.rows) {
      const esperado = (Number(row.rinde_kg_ha) * Number(row.superficie_sembrada_ha)) / 1000;
      expect(Number(row.produccion_tn)).toBeCloseTo(esperado, 6);
    }
  });

  it('maíz: margen_bruto = ingreso − costos/ha − flete×toneladas', () => {
    for (const row of MAIZ_MARGEN_DEMO.rows) {
      const rindeTn = Number(row.rinde_qq_ha) * 0.1;
      const ingreso = rindeTn * Number(row.precio_usd_tn);
      const costosHa =
        Number(row.costo_semilla_usd_ha) +
        Number(row.costo_fertilizante_usd_ha) +
        Number(row.costo_agroquimicos_usd_ha) +
        Number(row.alquiler_usd_ha);
      const flete = rindeTn * Number(row.flete_usd_tn);
      expect(Number(row.margen_bruto_usd_ha)).toBeCloseTo(ingreso - costosHa - flete, 6);
    }
  });

  it('trigo: el precio local acompaña a Chicago (descuento estable)', () => {
    for (const row of TRIGO_PRECIO_DEMO.rows) {
      const descuento = Number(row.precio_chicago_usd_tn) - Number(row.precio_local_usd_tn);
      expect(descuento).toBeGreaterThan(0);
      expect(descuento).toBeLessThan(60);
    }
  });
});

describe('agroDatasetToCsv', () => {
  it('genera header + una línea por fila', () => {
    const csv = agroDatasetToCsv(SOJA_RINDE_DEMO);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1 + SOJA_RINDE_DEMO.rows.length);
    expect(lines[0]).toBe(SOJA_RINDE_DEMO.columns.join(','));
  });

  it('escapa valores con comas o comillas', () => {
    const csv = agroDatasetToCsv({
      id: 'x', name: 'x', description: 'x', crop: 'otro', synthetic: true,
      columns: ['a', 'b'],
      rows: [{ a: 'uno, dos', b: 'con "comillas"' }],
    });
    expect(csv.split('\n')[1]).toBe('"uno, dos","con ""comillas"""');
  });
});
