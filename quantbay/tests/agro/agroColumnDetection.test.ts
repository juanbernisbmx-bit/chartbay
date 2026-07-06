import { describe, expect, it } from 'vitest';
import {
  detectAgroColumns,
  normalizeAgroHeader,
} from '../../src/verticals/agro/agroColumnDetection';
import type { AgroColumnRole } from '../../src/verticals/agro/agroTypes';

function roleOf(headers: string[], header: string): AgroColumnRole {
  const detection = detectAgroColumns(headers);
  const column = detection.columns.find(c => c.original === header);
  if (!column) throw new Error(`columna no encontrada: ${header}`);
  return column.role;
}

describe('normalizeAgroHeader', () => {
  it('pasa a minúsculas, saca acentos y reemplaza separadores por _', () => {
    expect(normalizeAgroHeader('  Precipitación (mm) ')).toBe('precipitacion_(mm)');
    expect(normalizeAgroHeader('Kg/Ha')).toBe('kg_ha');
    expect(normalizeAgroHeader('kg ha')).toBe('kg_ha');
    expect(normalizeAgroHeader('kg-ha')).toBe('kg_ha');
    expect(normalizeAgroHeader('Campaña')).toBe('campana');
    expect(normalizeAgroHeader('USD/TN')).toBe('usd_tn');
  });

  it('colapsa separadores repetidos y bordes', () => {
    expect(normalizeAgroHeader('__rinde  kg//ha__')).toBe('rinde_kg_ha');
  });
});

describe('detectAgroColumns', () => {
  it('detecta aliases en español', () => {
    const headers = ['rinde', 'lluvia', 'temperatura', 'precio', 'costo', 'margen',
      'campaña', 'provincia', 'produccion', 'superficie', 'flete', 'alquiler',
      'fertilizante', 'semilla', 'herbicida', 'tipo_cambio'];
    const detection = detectAgroColumns(headers);
    const roles = detection.columns.map(c => c.role);
    expect(roles).toEqual([
      'yield', 'rainfall', 'temperature', 'price', 'cost', 'margin',
      'season', 'province', 'production', 'area_planted', 'freight', 'rent',
      'fertilizer', 'seed', 'agrochemical', 'exchange_rate',
    ]);
  });

  it('detecta aliases en inglés', () => {
    expect(roleOf(['yield'], 'yield')).toBe('yield');
    expect(roleOf(['rainfall'], 'rainfall')).toBe('rainfall');
    expect(roleOf(['temperature'], 'temperature')).toBe('temperature');
    expect(roleOf(['price'], 'price')).toBe('price');
    expect(roleOf(['gross_margin'], 'gross_margin')).toBe('margin');
    expect(roleOf(['season'], 'season')).toBe('season');
    expect(roleOf(['exchange_rate'], 'exchange_rate')).toBe('exchange_rate');
    expect(roleOf(['area_harvested'], 'area_harvested')).toBe('area_harvested');
  });

  it('detecta fecha/date como season (series de precios reales)', () => {
    expect(roleOf(['fecha'], 'fecha')).toBe('season');
    expect(roleOf(['date'], 'date')).toBe('season');
  });

  it('tolera acentos', () => {
    expect(roleOf(['Precipitación'], 'Precipitación')).toBe('rainfall');
    expect(roleOf(['Producción'], 'Producción')).toBe('production');
    expect(roleOf(['Región'], 'Región')).toBe('region');
    expect(roleOf(['Dólar'], 'Dólar')).toBe('exchange_rate');
    expect(roleOf(['Campaña'], 'Campaña')).toBe('season');
    expect(roleOf(['Agroquímicos'], 'Agroquímicos')).toBe('agrochemical');
  });

  it('tolera kg/ha, qq/ha y usd/tn con mayúsculas y espacios', () => {
    expect(roleOf(['Kg/Ha'], 'Kg/Ha')).toBe('yield');
    expect(roleOf(['QQ/HA'], 'QQ/HA')).toBe('yield');
    expect(roleOf(['qq ha'], 'qq ha')).toBe('yield');
    expect(roleOf(['USD/TN'], 'USD/TN')).toBe('price');
  });

  it('detecta roles dentro de headers compuestos', () => {
    expect(roleOf(['rinde_kg_ha'], 'rinde_kg_ha')).toBe('yield');
    expect(roleOf(['lluvia_mm'], 'lluvia_mm')).toBe('rainfall');
    expect(roleOf(['superficie_sembrada_ha'], 'superficie_sembrada_ha')).toBe('area_planted');
    expect(roleOf(['superficie_cosechada_ha'], 'superficie_cosechada_ha')).toBe('area_harvested');
    // el sustantivo principal va primero: flete_usd_tn es flete, no precio
    expect(roleOf(['flete_usd_tn'], 'flete_usd_tn')).toBe('freight');
    expect(roleOf(['margen_bruto_usd_ha'], 'margen_bruto_usd_ha')).toBe('margin');
    expect(roleOf(['precio_chicago_usd_tn'], 'precio_chicago_usd_tn')).toBe('price');
  });

  it('no muta el input', () => {
    const headers = ['Rinde', 'Lluvia'];
    const copia = [...headers];
    detectAgroColumns(headers);
    expect(headers).toEqual(copia);
  });

  it('devuelve unknown para columnas no agro', () => {
    const detection = detectAgroColumns(['nombre_cliente', 'email', 'observaciones_generales']);
    expect(detection.columns.every(c => c.role === 'unknown')).toBe(true);
    expect(detection.byRole).toEqual({});
  });

  it('maneja headers vacíos', () => {
    expect(detectAgroColumns([]).columns).toEqual([]);
    const detection = detectAgroColumns(['', '   ']);
    expect(detection.columns).toHaveLength(2);
    expect(detection.columns.every(c => c.role === 'unknown')).toBe(true);
  });

  it('maneja duplicados con warning', () => {
    const detection = detectAgroColumns(['rinde', 'Rinde ']);
    expect(detection.warnings.some(w => w.includes('duplicadas'))).toBe(true);
    expect(detection.byRole.yield).toEqual(['rinde', 'Rinde ']);
  });

  it('asigna mayor confianza al match exacto que al parcial', () => {
    const detection = detectAgroColumns(['rinde', 'rinde_promedio_zonal']);
    const [exacto, parcial] = detection.columns;
    expect(exacto.confidence).toBe(1);
    expect(parcial.role).toBe('yield');
    expect(parcial.confidence).toBeLessThan(1);
    expect(parcial.confidence).toBeGreaterThan(0);
  });

  it('detecta los headers reales del recorte de MAGyP (estimaciones agrícolas)', () => {
    const headers = [
      'cultivo', 'campania', 'provincia',
      'sup_sembrada_ha', 'sup_cosechada_ha', 'produccion_tn', 'rinde_kg_ha',
    ];
    const detection = detectAgroColumns(headers);
    const roles = detection.columns.map(c => c.role);
    expect(roles).toEqual([
      'crop', 'season', 'province',
      'area_planted', 'area_harvested', 'production', 'yield',
    ]);
    expect(detection.warnings).toEqual([]);
  });

  it('agrupa headers por rol en byRole', () => {
    const detection = detectAgroColumns(['precio_local_usd_tn', 'precio_chicago_usd_tn', 'tipo_cambio']);
    expect(detection.byRole.price).toEqual(['precio_local_usd_tn', 'precio_chicago_usd_tn']);
    expect(detection.byRole.exchange_rate).toEqual(['tipo_cambio']);
  });
});
