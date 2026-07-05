import { describe, expect, it } from 'vitest';
import {
  AGRO_CSV_TEMPLATES,
  agroCsvTemplateToCsv,
  getAgroCsvTemplate,
  listAgroCsvTemplates,
} from '../../src/verticals/agro/agroCsvTemplates';
import { detectAgroColumns } from '../../src/verticals/agro/agroColumnDetection';
import { suggestAgroModelPresets } from '../../src/verticals/agro/agroModelPresets';

describe('AGRO_CSV_TEMPLATES', () => {
  it('incluye los 5 templates mínimos requeridos', () => {
    const ids = AGRO_CSV_TEMPLATES.map(t => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(['rinde', 'clima-agregado', 'precios', 'margen', 'produccion'])
    );
  });

  it('cada template tiene columnas requeridas, ejemplo de filas y modelo recomendado', () => {
    for (const template of AGRO_CSV_TEMPLATES) {
      expect(template.requiredColumns.length).toBeGreaterThan(0);
      expect(template.exampleRows.length).toBeGreaterThan(0);
      expect(template.recommendedModelType).toBeTruthy();
      expect(template.description.length).toBeGreaterThan(0);
    }
  });

  it('cada fila de ejemplo tiene al menos las columnas requeridas', () => {
    for (const template of AGRO_CSV_TEMPLATES) {
      for (const row of template.exampleRows) {
        for (const required of template.requiredColumns) {
          expect(row[required]).not.toBeUndefined();
        }
      }
    }
  });

  it('no repite columnas entre requeridas y opcionales dentro de un mismo template', () => {
    for (const template of AGRO_CSV_TEMPLATES) {
      const overlap = template.requiredColumns.filter(c => template.optionalColumns.includes(c));
      expect(overlap).toEqual([]);
    }
  });

  it('cada template completo puede sugerir su modelo recomendado', () => {
    for (const template of AGRO_CSV_TEMPLATES) {
      const columns = [...template.requiredColumns, ...template.optionalColumns];
      const suggestions = suggestAgroModelPresets(detectAgroColumns(columns));
      expect(suggestions.some(s => s.preset.type === template.recommendedModelType)).toBe(true);
    }
  });
});

describe('getAgroCsvTemplate / listAgroCsvTemplates', () => {
  it('encuentra un template existente por id', () => {
    expect(getAgroCsvTemplate('margen')?.recommendedModelType).toBe('margin');
  });

  it('devuelve undefined para un id inexistente', () => {
    expect(getAgroCsvTemplate('no-existe')).toBeUndefined();
  });

  it('lista todos los templates', () => {
    expect(listAgroCsvTemplates()).toHaveLength(AGRO_CSV_TEMPLATES.length);
  });
});

describe('agroCsvTemplateToCsv', () => {
  it('genera header con columnas requeridas + opcionales y una línea por fila', () => {
    const template = getAgroCsvTemplate('rinde')!;
    const csv = agroCsvTemplateToCsv(template);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(1 + template.exampleRows.length);
    expect(lines[0]).toBe([...template.requiredColumns, ...template.optionalColumns].join(','));
  });

  it('deja vacías las celdas de columnas opcionales ausentes en una fila', () => {
    const template = getAgroCsvTemplate('produccion')!;
    const csv = agroCsvTemplateToCsv(template);
    const [header, firstRow] = csv.split('\n');
    const headerCols = header.split(',');
    const values = firstRow.split(',');
    const rinde_kg_haIndex = headerCols.indexOf('rinde_kg_ha');
    expect(values[rinde_kg_haIndex]).toBe('');
  });
});
