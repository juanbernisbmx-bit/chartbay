import { describe, expect, it } from 'vitest';
import {
  calculateAgroGrossMargin,
  calculateAgroMargin,
  calculateAgroMarginPerHectare,
  calculateAgroRevenue,
  calculateAgroTotalCost,
  calculateBreakEvenPrice,
  calculateBreakEvenYield,
  runAgroMarginScenarios,
  yieldToTonsPerHa,
} from '../../src/verticals/agro/agroMargin';
import type { AgroMarginInput } from '../../src/verticals/agro/agroTypes';

// 100 ha de soja: 3000 kg/ha (3 tn/ha), 300 USD/tn, 800 USD/ha de costos
// directos + 25 USD/tn de flete → ingreso 90.000, costo 87.500, margen 2.500.
const BASE: AgroMarginInput = {
  crop: 'soja',
  hectares: 100,
  expectedYield: 3000,
  yieldUnit: 'kg_ha',
  expectedPriceUsdPerTon: 300,
  seedCostUsdPerHa: 80,
  fertilizerCostUsdPerHa: 120,
  agrochemicalCostUsdPerHa: 60,
  laborCostUsdPerHa: 90,
  freightCostUsdPerTon: 25,
  rentCostUsdPerHa: 400,
  otherCostUsdPerHa: 50,
};

describe('yieldToTonsPerHa', () => {
  it('convierte kg/ha, qq/ha y tn/ha a toneladas por hectárea', () => {
    expect(yieldToTonsPerHa(3000, 'kg_ha')).toBe(3);
    expect(yieldToTonsPerHa(90, 'qq_ha')).toBeCloseTo(9, 10);
    expect(yieldToTonsPerHa(4, 'tn_ha')).toBe(4);
  });
});

describe('calculateAgroRevenue', () => {
  it('calcula ingreso bruto en kg/ha', () => {
    expect(calculateAgroRevenue(BASE)).toBe(90000);
  });

  it('calcula ingreso bruto en qq/ha', () => {
    const input: AgroMarginInput = {
      crop: 'maiz', hectares: 50, expectedYield: 90, yieldUnit: 'qq_ha', expectedPriceUsdPerTon: 170,
    };
    expect(calculateAgroRevenue(input)).toBeCloseTo(76500, 8);
  });

  it('calcula ingreso bruto en tn/ha', () => {
    const input: AgroMarginInput = {
      crop: 'trigo', hectares: 10, expectedYield: 4, yieldUnit: 'tn_ha', expectedPriceUsdPerTon: 200,
    };
    expect(calculateAgroRevenue(input)).toBe(8000);
  });
});

describe('calculateAgroTotalCost', () => {
  it('suma costos por hectárea y flete por tonelada', () => {
    // 800 USD/ha × 100 ha + 25 USD/tn × 300 tn = 80.000 + 7.500
    expect(calculateAgroTotalCost(BASE)).toBe(87500);
  });

  it('los costos no cargados cuentan como 0', () => {
    const input: AgroMarginInput = {
      crop: 'soja', hectares: 10, expectedYield: 3000, yieldUnit: 'kg_ha', expectedPriceUsdPerTon: 300,
    };
    expect(calculateAgroTotalCost(input)).toBe(0);
  });
});

describe('margen bruto y por hectárea', () => {
  it('calcula margen bruto', () => {
    expect(calculateAgroGrossMargin(BASE)).toBe(2500);
  });

  it('calcula margen por hectárea', () => {
    expect(calculateAgroMarginPerHectare(BASE)).toBe(25);
  });
});

describe('puntos de indiferencia', () => {
  it('calcula rinde de indiferencia en la unidad original', () => {
    // 87.500 / (100 × 300) = 2,9167 tn/ha → 2916,67 kg/ha
    expect(calculateBreakEvenYield(BASE)).toBeCloseTo(2916.6667, 3);
  });

  it('calcula precio de indiferencia', () => {
    expect(calculateBreakEvenPrice(BASE)).toBeCloseTo(291.6667, 3);
  });

  it('devuelve null si el precio es 0 (rinde de indiferencia indefinido)', () => {
    expect(calculateBreakEvenYield({ ...BASE, expectedPriceUsdPerTon: 0 })).toBeNull();
  });

  it('devuelve null si el rinde es 0 (precio de indiferencia indefinido)', () => {
    expect(calculateBreakEvenPrice({ ...BASE, expectedYield: 0 })).toBeNull();
  });
});

describe('runAgroMarginScenarios', () => {
  it('genera pesimista, base y optimista con ±10% en rinde y precio', () => {
    const [pesimista, base, optimista] = runAgroMarginScenarios(BASE);

    expect(pesimista.id).toBe('pesimista');
    expect(base.id).toBe('base');
    expect(optimista.id).toBe('optimista');

    // Pesimista: 2,7 tn/ha × 270 USD/tn → ingreso 72.900; flete 25 × 270 tn = 6.750
    expect(pesimista.revenueUsd).toBeCloseTo(72900, 6);
    expect(pesimista.totalCostUsd).toBeCloseTo(86750, 6);
    expect(pesimista.grossMarginUsd).toBeCloseTo(-13850, 6);

    expect(base.revenueUsd).toBe(90000);
    expect(base.grossMarginUsd).toBe(2500);

    // Optimista: 3,3 tn/ha × 330 USD/tn → 108.900; flete 25 × 330 tn = 8.250
    expect(optimista.revenueUsd).toBeCloseTo(108900, 6);
    expect(optimista.totalCostUsd).toBeCloseTo(88250, 6);
    expect(optimista.grossMarginUsd).toBeCloseTo(20650, 6);
  });
});

describe('calculateAgroMargin (resultado completo)', () => {
  it('integra margen, indiferencia y escenarios', () => {
    const result = calculateAgroMargin(BASE);
    expect(result.crop).toBe('soja');
    expect(result.yieldTnHa).toBe(3);
    expect(result.totalTons).toBe(300);
    expect(result.revenueUsd).toBe(90000);
    expect(result.totalCostUsd).toBe(87500);
    expect(result.grossMarginUsd).toBe(2500);
    expect(result.marginPerHectareUsd).toBe(25);
    expect(result.breakEvenYield).toBeCloseTo(2916.6667, 3);
    expect(result.breakEvenYieldUnit).toBe('kg_ha');
    expect(result.breakEvenPriceUsdPerTon).toBeCloseTo(291.6667, 3);
    expect(result.scenarios).toHaveLength(3);
    expect(result.warnings).toEqual([]);
  });

  it('avisa cuando no hay costos cargados', () => {
    const result = calculateAgroMargin({
      crop: 'soja', hectares: 10, expectedYield: 3000, yieldUnit: 'kg_ha', expectedPriceUsdPerTon: 300,
    });
    expect(result.warnings.some(w => w.includes('ningún costo'))).toBe(true);
  });

  it('avisa cuando el margen base es negativo', () => {
    const result = calculateAgroMargin({ ...BASE, expectedPriceUsdPerTon: 250 });
    expect(result.grossMarginUsd).toBeLessThan(0);
    expect(result.warnings.some(w => w.includes('negativo'))).toBe(true);
  });
});

describe('validación de input', () => {
  it('rechaza hectáreas <= 0', () => {
    expect(() => calculateAgroMargin({ ...BASE, hectares: 0 })).toThrow(/hectáreas/i);
    expect(() => calculateAgroMargin({ ...BASE, hectares: -5 })).toThrow(/hectáreas/i);
  });

  it('rechaza rinde o precio negativos', () => {
    expect(() => calculateAgroMargin({ ...BASE, expectedYield: -1 })).toThrow(/rinde/i);
    expect(() => calculateAgroMargin({ ...BASE, expectedPriceUsdPerTon: -1 })).toThrow(/precio/i);
  });

  it('rechaza costos negativos', () => {
    expect(() => calculateAgroMargin({ ...BASE, seedCostUsdPerHa: -10 })).toThrow(/seedCostUsdPerHa/);
    expect(() => calculateAgroMargin({ ...BASE, freightCostUsdPerTon: -1 })).toThrow(/freightCostUsdPerTon/);
  });

  it('rechaza NaN e Infinity', () => {
    expect(() => calculateAgroRevenue({ ...BASE, expectedYield: NaN })).toThrow(/finito/);
    expect(() => calculateAgroRevenue({ ...BASE, hectares: Infinity })).toThrow(/finito/);
    expect(() => calculateAgroTotalCost({ ...BASE, rentCostUsdPerHa: Infinity })).toThrow(/finito/);
  });

  it('los resultados nunca son NaN ni Infinity con input válido', () => {
    const result = calculateAgroMargin(BASE);
    const numeros = [
      result.yieldTnHa, result.totalTons, result.revenueUsd, result.totalCostUsd,
      result.grossMarginUsd, result.marginPerHectareUsd,
      ...result.scenarios.flatMap(s => [s.revenueUsd, s.totalCostUsd, s.grossMarginUsd, s.marginPerHectareUsd]),
    ];
    for (const n of numeros) expect(Number.isFinite(n)).toBe(true);
  });
});
