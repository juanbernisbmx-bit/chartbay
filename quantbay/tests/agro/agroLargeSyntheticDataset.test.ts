import { describe, expect, it } from 'vitest';
import { generateLargeAgroSyntheticDataset } from '../../src/verticals/agro/agroExamples';
import { detectAgroColumns } from '../../src/verticals/agro/agroColumnDetection';
import { suggestAgroModelPresets } from '../../src/verticals/agro/agroModelPresets';

describe('generateLargeAgroSyntheticDataset', () => {
  it('genera 1000 filas por defecto (20 campañas × 5 provincias × 10 deptos)', () => {
    const dataset = generateLargeAgroSyntheticDataset();
    expect(dataset.rows).toHaveLength(1000);
  });

  it('respeta seasonsCount, provinces y departmentsPerProvince personalizados', () => {
    const dataset = generateLargeAgroSyntheticDataset({
      seasonsCount: 3,
      provinces: ['Chaco', 'Salta'],
      departmentsPerProvince: 4,
    });
    expect(dataset.rows).toHaveLength(3 * 2 * 4);
  });

  it('marca synthetic: true e incluye disclaimer en la descripción', () => {
    const dataset = generateLargeAgroSyntheticDataset();
    expect(dataset.synthetic).toBe(true);
    expect(dataset.description).toMatch(/SINTÉTICO/i);
    expect(dataset.description.toLowerCase()).toContain('no usar para decisiones productivas');
  });

  it('produccion_tn es coherente con rinde_kg_ha × superficie_cosechada_ha / 1000 en cada fila', () => {
    const dataset = generateLargeAgroSyntheticDataset({ seasonsCount: 5, departmentsPerProvince: 3 });
    for (const row of dataset.rows) {
      const expected = Math.round((Number(row.rinde_kg_ha) * Number(row.superficie_cosechada_ha)) / 1000);
      expect(row.produccion_tn).toBe(expected);
    }
  });

  it('la superficie cosechada nunca supera la sembrada', () => {
    const dataset = generateLargeAgroSyntheticDataset({ seasonsCount: 5 });
    for (const row of dataset.rows) {
      expect(Number(row.superficie_cosechada_ha)).toBeLessThanOrEqual(Number(row.superficie_sembrada_ha));
    }
  });

  it('es determinista: la misma seed produce el mismo dataset', () => {
    const a = generateLargeAgroSyntheticDataset({ seed: 42, seasonsCount: 2 });
    const b = generateLargeAgroSyntheticDataset({ seed: 42, seasonsCount: 2 });
    expect(a.rows).toEqual(b.rows);
  });

  it('seeds distintas producen datasets distintos', () => {
    const a = generateLargeAgroSyntheticDataset({ seed: 1, seasonsCount: 2 });
    const b = generateLargeAgroSyntheticDataset({ seed: 2, seasonsCount: 2 });
    expect(a.rows).not.toEqual(b.rows);
  });

  it('sin seed explícita también es reproducible (seed por defecto fija)', () => {
    const a = generateLargeAgroSyntheticDataset({ seasonsCount: 2 });
    const b = generateLargeAgroSyntheticDataset({ seasonsCount: 2 });
    expect(a.rows).toEqual(b.rows);
  });

  it('respeta includeWeather/includePrices/includeCosts en false', () => {
    const dataset = generateLargeAgroSyntheticDataset({
      seasonsCount: 1, departmentsPerProvince: 1,
      includeWeather: false, includePrices: false, includeCosts: false,
    });
    expect(dataset.columns).not.toContain('lluvia_total_mm');
    expect(dataset.columns).not.toContain('temperatura_media');
    expect(dataset.columns).not.toContain('precio_usd_tn');
    expect(dataset.columns).not.toContain('costo_usd_ha');
    expect(dataset.rows[0].lluvia_total_mm).toBeUndefined();
  });

  it('usa el cultivo pedido en todas las filas', () => {
    const dataset = generateLargeAgroSyntheticDataset({ crop: 'maiz', seasonsCount: 1, departmentsPerProvince: 1 });
    expect(dataset.crop).toBe('maiz');
    expect(dataset.rows.every(row => row.cultivo === 'maiz')).toBe(true);
  });

  it('detectAgroColumns reconoce todos los headers del dataset grande', () => {
    const dataset = generateLargeAgroSyntheticDataset();
    const detection = detectAgroColumns(dataset.columns);
    const unknown = detection.columns.filter(c => c.role === 'unknown');
    expect(unknown).toEqual([]);
  });

  it('los presets funcionan sobre el dataset grande (sugiere el modelo de rinde)', () => {
    const dataset = generateLargeAgroSyntheticDataset({ seasonsCount: 3 });
    const detection = detectAgroColumns(dataset.columns);
    const suggestions = suggestAgroModelPresets(detection);
    const yieldSuggestion = suggestions.find(s => s.preset.id === 'agro-yield');
    expect(yieldSuggestion).toBeDefined();
    expect(yieldSuggestion!.yColumn).toBe('rinde_kg_ha');

    const productionSuggestion = suggestions.find(s => s.preset.id === 'agro-production');
    expect(productionSuggestion).toBeDefined();
  });
});
