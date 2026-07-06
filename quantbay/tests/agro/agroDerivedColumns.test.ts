import { describe, expect, it } from 'vitest';
import {
  AGRO_TREND_COLUMN,
  addAgroDerivedColumns,
  buildSeasonTrendMap,
  parseSeasonStartYear,
  rainfallHeaderFromSquaredColumn,
  rainfallSquaredColumnName,
} from '../../src/verticals/agro/agroDerivedColumns';
import { detectAgroColumns } from '../../src/verticals/agro/agroColumnDetection';

describe('rainfallSquaredColumnName / rainfallHeaderFromSquaredColumn', () => {
  it('genera y reconoce el nombre de la columna al cuadrado', () => {
    expect(rainfallSquaredColumnName('lluvia_mm')).toBe('lluvia_mm_cuadrado');
    expect(rainfallHeaderFromSquaredColumn('lluvia_mm_cuadrado')).toBe('lluvia_mm');
  });

  it('devuelve null si el nombre no es una columna al cuadrado', () => {
    expect(rainfallHeaderFromSquaredColumn('lluvia_mm')).toBeNull();
    expect(rainfallHeaderFromSquaredColumn('temperatura')).toBeNull();
  });
});

describe('parseSeasonStartYear', () => {
  it('parsea formato campaña "2023/24"', () => {
    expect(parseSeasonStartYear('2023/24')).toBe(2023);
  });

  it('parsea formato campaña "2005/2006"', () => {
    expect(parseSeasonStartYear('2005/2006')).toBe(2005);
  });

  it('parsea formato año simple "2023"', () => {
    expect(parseSeasonStartYear('2023')).toBe(2023);
  });

  it('devuelve null para formatos no reconocidos', () => {
    expect(parseSeasonStartYear('campaña-actual')).toBeNull();
    expect(parseSeasonStartYear('')).toBeNull();
  });
});

describe('buildSeasonTrendMap', () => {
  it('asigna 0,1,2,... en orden cronológico ascendente, sin importar el orden de entrada', () => {
    const map = buildSeasonTrendMap(['2022/23', '2020/21', '2021/22']);
    expect(map.get('2020/21')).toBe(0);
    expect(map.get('2021/22')).toBe(1);
    expect(map.get('2022/23')).toBe(2);
  });

  it('repite el mismo valor para etiquetas repetidas', () => {
    const map = buildSeasonTrendMap(['2020/21', '2020/21', '2021/22']);
    expect(map.get('2020/21')).toBe(0);
    expect(map.get('2021/22')).toBe(1);
    expect(map.size).toBe(2);
  });

  it('mezcla formatos "2005/2006" y "2023" correctamente', () => {
    const map = buildSeasonTrendMap(['2023', '2005/2006', '2010']);
    expect(map.get('2005/2006')).toBe(0);
    expect(map.get('2010')).toBe(1);
    expect(map.get('2023')).toBe(2);
  });

  it('deja null las etiquetas no parseables', () => {
    const map = buildSeasonTrendMap(['2020/21', 'sin-fecha']);
    expect(map.get('2020/21')).toBe(0);
    expect(map.get('sin-fecha')).toBeNull();
  });
});

describe('addAgroDerivedColumns', () => {
  it('agrega lluvia_mm_cuadrado con el valor al cuadrado', () => {
    const dataset = {
      columns: ['campaña', 'lluvia_mm', 'rinde_kg_ha'],
      rows: [
        { 'campaña': '2020/21', lluvia_mm: 800, rinde_kg_ha: 3000 },
        { 'campaña': '2021/22', lluvia_mm: 600, rinde_kg_ha: 2500 },
      ],
    };
    const detection = detectAgroColumns(dataset.columns);
    const result = addAgroDerivedColumns(dataset, detection);

    expect(result.columns).toContain('lluvia_mm_cuadrado');
    expect(result.addedColumns).toContain('lluvia_mm_cuadrado');
    expect(result.rows[0].lluvia_mm_cuadrado).toBe(800 * 800);
    expect(result.rows[1].lluvia_mm_cuadrado).toBe(600 * 600);
    // no muta el dataset original
    expect(dataset.columns).not.toContain('lluvia_mm_cuadrado');
    expect(dataset.rows[0]).not.toHaveProperty('lluvia_mm_cuadrado');
  });

  it('agrega tendencia codificada cronológicamente a partir de la campaña', () => {
    const dataset = {
      columns: ['campaña', 'rinde_kg_ha'],
      rows: [
        { 'campaña': '2021/22', rinde_kg_ha: 2500 },
        { 'campaña': '2020/21', rinde_kg_ha: 3000 },
        { 'campaña': '2022/23', rinde_kg_ha: 2000 },
      ],
    };
    const detection = detectAgroColumns(dataset.columns);
    const result = addAgroDerivedColumns(dataset, detection);

    expect(result.columns).toContain(AGRO_TREND_COLUMN);
    expect(result.rows[0].tendencia).toBe(1); // 2021/22
    expect(result.rows[1].tendencia).toBe(0); // 2020/21 (más vieja)
    expect(result.rows[2].tendencia).toBe(2); // 2022/23 (más nueva)
  });

  it('agrega ambas columnas cuando hay lluvia y campaña', () => {
    const dataset = {
      columns: ['campaña', 'lluvia_mm', 'rinde_kg_ha'],
      rows: [{ 'campaña': '2020/21', lluvia_mm: 800, rinde_kg_ha: 3000 }],
    };
    const detection = detectAgroColumns(dataset.columns);
    const result = addAgroDerivedColumns(dataset, detection);
    expect(result.addedColumns.sort()).toEqual(['lluvia_mm_cuadrado', 'tendencia']);
  });

  it('no agrega columnas si no hay rol lluvia ni campaña', () => {
    const dataset = {
      columns: ['precio_usd_tn', 'costo_usd_ha'],
      rows: [{ precio_usd_tn: 300, costo_usd_ha: 200 }],
    };
    const detection = detectAgroColumns(dataset.columns);
    const result = addAgroDerivedColumns(dataset, detection);
    expect(result.addedColumns).toEqual([]);
    expect(result.columns).toEqual(dataset.columns);
  });

  it('parsea correctamente el formato real de MAGyP ("2005/2006")', () => {
    const dataset = {
      columns: ['cultivo', 'campania', 'provincia', 'rinde_kg_ha'],
      rows: [
        { cultivo: 'soja', campania: '2007/2008', provincia: 'X', rinde_kg_ha: 2500 },
        { cultivo: 'soja', campania: '2005/2006', provincia: 'X', rinde_kg_ha: 2600 },
        { cultivo: 'soja', campania: '2006/2007', provincia: 'X', rinde_kg_ha: 2700 },
      ],
    };
    const detection = detectAgroColumns(dataset.columns);
    const result = addAgroDerivedColumns(dataset, detection);
    expect(result.rows[0].tendencia).toBe(2);
    expect(result.rows[1].tendencia).toBe(0);
    expect(result.rows[2].tendencia).toBe(1);
  });

  it('agrega advertencia si alguna campaña no se puede interpretar', () => {
    const dataset = {
      columns: ['campaña', 'rinde_kg_ha'],
      rows: [
        { 'campaña': '2020/21', rinde_kg_ha: 3000 },
        { 'campaña': 'sin-fecha', rinde_kg_ha: 2500 },
      ],
    };
    const detection = detectAgroColumns(dataset.columns);
    const result = addAgroDerivedColumns(dataset, detection);
    expect(result.warnings.some(w => w.includes('sin-fecha'))).toBe(true);
    expect(result.rows[1].tendencia).toBe('');
  });

  it('no duplica columnas si ya existen', () => {
    const dataset = {
      columns: ['campaña', 'lluvia_mm', 'lluvia_mm_cuadrado', 'tendencia'],
      rows: [{ 'campaña': '2020/21', lluvia_mm: 800, lluvia_mm_cuadrado: 999, tendencia: 99 }],
    };
    const detection = detectAgroColumns(dataset.columns);
    const result = addAgroDerivedColumns(dataset, detection);
    expect(result.addedColumns).toEqual([]);
    expect(result.rows[0].lluvia_mm_cuadrado).toBe(999);
    expect(result.rows[0].tendencia).toBe(99);
  });
});
