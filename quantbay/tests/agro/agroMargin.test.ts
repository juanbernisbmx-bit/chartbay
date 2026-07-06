import { describe, expect, it } from 'vitest';
import {
  buildAgroSensitivityMatrix,
  calculateAgroGrossMargin,
  calculateAgroMargin,
  calculateAgroMarginPerHectare,
  calculateAgroRevenue,
  calculateAgroTotalCost,
  calculateBreakEvenPrice,
  calculateBreakEvenYield,
  formatAgroMarginSummary,
  formatAgroSensitivityMatrix,
  runAgroMarginScenarios,
  yieldToTonsPerHa,
} from '../../src/verticals/agro/agroMargin';
import type { AgroMarginInput } from '../../src/verticals/agro/agroTypes';

// 100 ha de soja: 3000 kg/ha (3 tn/ha), 300 USD/tn, 800 USD/ha de costos
// directos + 25 USD/tn de flete → ingreso 90.000, costo 87.500, margen 2.500.
// Sin cosecha ni comercialización (a propósito: dispara la advertencia).
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

// Margen completo y realista: cosecha 9% + comercialización 8% del ingreso.
// Precio 400 para que el margen quede positivo y sin advertencias.
const FULL: AgroMarginInput = {
  ...BASE,
  expectedPriceUsdPerTon: 400,
  harvestCostPctRevenue: 9,
  sellingCostPctRevenue: 8,
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

  it('suma cosecha y comercialización como % del ingreso bruto', () => {
    // Ingreso FULL = 300 tn × 400 = 120.000; 17% = 20.400.
    // Costo = 80.000 + 7.500 + 20.400 = 107.900.
    expect(calculateAgroTotalCost(FULL)).toBeCloseTo(107900, 8);
  });

  it('valúa el alquiler en qq de soja con el precio esperado cuando el cultivo es soja', () => {
    // 18 qq/ha = 1,8 tn/ha × 300 USD/tn = 540 USD/ha extra × 100 ha = 54.000.
    const input: AgroMarginInput = { ...BASE, rentQqSojaPerHa: 18 };
    expect(calculateAgroTotalCost(input)).toBeCloseTo(87500 + 54000, 8);
  });

  it('valúa el alquiler en qq con el precio de referencia cuando se indica', () => {
    // 18 qq/ha = 1,8 tn/ha × 320 USD/tn = 576 USD/ha × 100 ha = 57.600.
    const input: AgroMarginInput = { ...BASE, rentQqSojaPerHa: 18, sojaReferencePriceUsdPerTon: 320 };
    expect(calculateAgroTotalCost(input)).toBeCloseTo(87500 + 57600, 8);
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

  it('calcula margen bruto con costos proporcionales al ingreso', () => {
    // 120.000 − 107.900 = 12.100
    expect(calculateAgroGrossMargin(FULL)).toBeCloseTo(12100, 8);
  });
});

describe('puntos de indiferencia', () => {
  it('calcula rinde de indiferencia resolviendo el flete al rinde de indiferencia (no al esperado)', () => {
    // y* = 800 / (300 − 25) = 2,9091 tn/ha → 2909,09 kg/ha.
    // (La fórmula anterior congelaba el flete al rinde esperado y daba 2916,67.)
    expect(calculateBreakEvenYield(BASE)).toBeCloseTo(2909.0909, 3);
  });

  it('calcula rinde de indiferencia con costos proporcionales al ingreso', () => {
    // a = 0,83; y* = 800 / (400 × 0,83 − 25) = 800 / 307 = 2,6059 tn/ha.
    expect(calculateBreakEvenYield(FULL)).toBeCloseTo((800 / 307) * 1000, 3);
  });

  it('calcula precio de indiferencia', () => {
    // p* = (800 + 25 × 3) / 3 = 291,67 (sin costos % coincide con la fórmula clásica).
    expect(calculateBreakEvenPrice(BASE)).toBeCloseTo(291.6667, 3);
  });

  it('calcula precio de indiferencia con costos proporcionales al ingreso', () => {
    // p* = (800 + 75) / (3 × 0,83) = 875 / 2,49 = 351,41.
    expect(calculateBreakEvenPrice(FULL)).toBeCloseTo(875 / 2.49, 3);
  });

  it('devuelve null si el precio es 0 (rinde de indiferencia indefinido)', () => {
    expect(calculateBreakEvenYield({ ...BASE, expectedPriceUsdPerTon: 0 })).toBeNull();
  });

  it('devuelve null si el flete supera al precio efectivo', () => {
    expect(calculateBreakEvenYield({ ...BASE, freightCostUsdPerTon: 300 })).toBeNull();
  });

  it('devuelve null si cosecha + comercialización se llevan todo el ingreso', () => {
    const input: AgroMarginInput = { ...BASE, harvestCostPctRevenue: 50, sellingCostPctRevenue: 50 };
    expect(calculateBreakEvenYield(input)).toBeNull();
    expect(calculateBreakEvenPrice(input)).toBeNull();
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

describe('buildAgroSensitivityMatrix', () => {
  it('genera 5×5 con ±20% por defecto y la celda central igual al margen/ha base', () => {
    const matrix = buildAgroSensitivityMatrix(BASE);
    expect(matrix.priceStepsUsdPerTon).toHaveLength(5);
    expect(matrix.yieldSteps).toHaveLength(5);
    expect(matrix.marginPerHaUsd).toHaveLength(5);
    expect(matrix.yieldUnit).toBe('kg_ha');

    // toBeCloseTo elemento a elemento: los factores (0,8 … 1,2) no son exactos
    // en punto flotante.
    [240, 270, 300, 330, 360].forEach((p, i) => expect(matrix.priceStepsUsdPerTon[i]).toBeCloseTo(p, 8));
    [2400, 2700, 3000, 3300, 3600].forEach((y, i) => expect(matrix.yieldSteps[i]).toBeCloseTo(y, 8));

    // Celda central = escenario base.
    expect(matrix.marginPerHaUsd[2][2]).toBeCloseTo(25, 8);
    // Esquina pesimista: 2,4 tn × 240 = 576; costos 800 + 25 × 2,4 = 860 → −284.
    expect(matrix.marginPerHaUsd[0][0]).toBeCloseTo(-284, 8);
    // Esquina optimista: 3,6 tn × 360 = 1296; costos 800 + 90 = 890 → 406.
    expect(matrix.marginPerHaUsd[4][4]).toBeCloseTo(406, 8);
  });

  it('las filas crecen con el rinde y las columnas con el precio', () => {
    const matrix = buildAgroSensitivityMatrix(BASE);
    for (let i = 0; i < 5; i++) {
      for (let j = 1; j < 5; j++) {
        expect(matrix.marginPerHaUsd[i][j]).toBeGreaterThan(matrix.marginPerHaUsd[i][j - 1]);
      }
    }
  });

  it('acepta steps y spread personalizados', () => {
    const matrix = buildAgroSensitivityMatrix(BASE, { steps: 3, spreadPct: 10 });
    [270, 300, 330].forEach((p, i) => expect(matrix.priceStepsUsdPerTon[i]).toBeCloseTo(p, 8));
    [2700, 3000, 3300].forEach((y, i) => expect(matrix.yieldSteps[i]).toBeCloseTo(y, 8));
  });

  it('rechaza steps inválidos', () => {
    expect(() => buildAgroSensitivityMatrix(BASE, { steps: 1 })).toThrow(/steps/);
    expect(() => buildAgroSensitivityMatrix(BASE, { steps: 2.5 })).toThrow(/steps/);
  });
});

describe('calculateAgroMargin (resultado completo)', () => {
  it('integra margen, indiferencia, escenarios y sensibilidad', () => {
    const result = calculateAgroMargin(FULL);
    expect(result.crop).toBe('soja');
    expect(result.yieldTnHa).toBe(3);
    expect(result.totalTons).toBe(300);
    expect(result.revenueUsd).toBe(120000);
    expect(result.totalCostUsd).toBeCloseTo(107900, 6);
    expect(result.grossMarginUsd).toBeCloseTo(12100, 6);
    expect(result.marginPerHectareUsd).toBeCloseTo(121, 6);
    expect(result.breakEvenYield).toBeCloseTo((800 / 307) * 1000, 3);
    expect(result.breakEvenYieldUnit).toBe('kg_ha');
    expect(result.breakEvenPriceUsdPerTon).toBeCloseTo(875 / 2.49, 3);
    expect(result.scenarios).toHaveLength(3);
    expect(result.sensitivity.marginPerHaUsd[2][2]).toBeCloseTo(121, 6);
    expect(result.warnings).toEqual([]);
  });

  it('avisa cuando hay costos pero no cosecha ni comercialización', () => {
    const result = calculateAgroMargin(BASE);
    expect(result.warnings.some(w => w.includes('sobreestimado'))).toBe(true);
  });

  it('avisa cuando el alquiler en qq de soja se valúa al precio esperado', () => {
    const result = calculateAgroMargin({ ...FULL, rentQqSojaPerHa: 18 });
    expect(result.warnings.some(w => w.includes('precio esperado'))).toBe(true);
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

  it('rechaza porcentajes fuera de 0-100', () => {
    expect(() => calculateAgroMargin({ ...BASE, harvestCostPctRevenue: 101 })).toThrow(/0 y 100/);
    expect(() => calculateAgroMargin({ ...BASE, sellingCostPctRevenue: -1 })).toThrow(/sellingCostPctRevenue/);
  });

  it('exige precio de referencia para alquiler en qq cuando el cultivo no es soja', () => {
    expect(() =>
      calculateAgroMargin({ ...BASE, crop: 'maiz', rentQqSojaPerHa: 18 })
    ).toThrow(/referencia/);
    // Con referencia explícita no lanza.
    expect(() =>
      calculateAgroMargin({ ...BASE, crop: 'maiz', rentQqSojaPerHa: 18, sojaReferencePriceUsdPerTon: 300 })
    ).not.toThrow();
  });

  it('rechaza NaN e Infinity', () => {
    expect(() => calculateAgroRevenue({ ...BASE, expectedYield: NaN })).toThrow(/finito/);
    expect(() => calculateAgroRevenue({ ...BASE, hectares: Infinity })).toThrow(/finito/);
    expect(() => calculateAgroTotalCost({ ...BASE, rentCostUsdPerHa: Infinity })).toThrow(/finito/);
  });

  it('los resultados nunca son NaN ni Infinity con input válido', () => {
    const result = calculateAgroMargin(FULL);
    const numeros = [
      result.yieldTnHa, result.totalTons, result.revenueUsd, result.totalCostUsd,
      result.grossMarginUsd, result.marginPerHectareUsd,
      ...result.scenarios.flatMap(s => [s.revenueUsd, s.totalCostUsd, s.grossMarginUsd, s.marginPerHectareUsd]),
      ...result.sensitivity.marginPerHaUsd.flat(),
    ];
    for (const n of numeros) expect(Number.isFinite(n)).toBe(true);
  });
});

describe('formatAgroSensitivityMatrix', () => {
  it('genera una tabla de texto con encabezado de precios y filas de rinde', () => {
    const text = formatAgroSensitivityMatrix(buildAgroSensitivityMatrix(BASE));
    const lines = text.split('\n');
    expect(lines).toHaveLength(6); // header + 5 filas
    expect(lines[0]).toContain('300 USD/tn');
    expect(lines[3]).toContain('3000'); // fila central de rinde
  });
});

describe('formatAgroMarginSummary', () => {
  it('incluye todos los campos requeridos del resumen', () => {
    const result = calculateAgroMargin(FULL);
    const summary = formatAgroMarginSummary(FULL, result);

    expect(summary).toContain('Cultivo: soja');
    expect(summary).toContain('Hectáreas: 100');
    expect(summary).toContain('Rinde esperado: 3000 kg/ha (3.000 tn/ha)');
    expect(summary).toContain('Precio esperado: 400.00 USD/tn');
    expect(summary).toContain('Cosecha: 9.0% del ingreso bruto');
    expect(summary).toContain('Gastos de comercialización: 8.0% del ingreso bruto');
    expect(summary).toContain('Ingreso bruto: 120000.00 USD');
    expect(summary).toContain('Margen por hectárea: 121.00 USD/ha');
    expect(summary).toContain('Rinde de indiferencia:');
    expect(summary).toContain('Precio de indiferencia:');
    expect(summary).toContain('Escenarios (±10% rinde y precio)');
    expect(summary).toContain('Sensibilidad precio × rinde');
    expect(summary).toContain('Pesimista');
    expect(summary).toContain('Optimista');
  });

  it('incluye el alquiler en qq cuando se usa', () => {
    const input: AgroMarginInput = { ...FULL, rentQqSojaPerHa: 18, sojaReferencePriceUsdPerTon: 320 };
    const result = calculateAgroMargin(input);
    const summary = formatAgroMarginSummary(input, result);
    expect(summary).toContain('Alquiler: 18 qq de soja/ha');
  });

  it('usa la unidad de rinde original, aunque difiera de la del punto de indiferencia', () => {
    const input: AgroMarginInput = { ...FULL, expectedYield: 90, yieldUnit: 'qq_ha' };
    const result = calculateAgroMargin(input);
    const summary = formatAgroMarginSummary(input, result);
    expect(summary).toContain('Rinde esperado: 90 qq/ha');
    expect(summary).toContain('qq/ha');
  });

  it('muestra N/D cuando no hay rinde o precio de indiferencia calculable', () => {
    const input: AgroMarginInput = { ...FULL, expectedPriceUsdPerTon: 0 };
    const result = calculateAgroMargin(input);
    const summary = formatAgroMarginSummary(input, result);
    expect(summary).toContain('Rinde de indiferencia: N/D');
  });

  it('incluye las advertencias del resultado cuando existen', () => {
    const input: AgroMarginInput = {
      crop: 'soja', hectares: 10, expectedYield: 3000, yieldUnit: 'kg_ha', expectedPriceUsdPerTon: 300,
    };
    const result = calculateAgroMargin(input);
    const summary = formatAgroMarginSummary(input, result);
    expect(summary).toContain('Advertencias');
    expect(summary).toContain('ningún costo');
  });

  it('no incluye la sección de advertencias cuando no hay ninguna', () => {
    const result = calculateAgroMargin(FULL);
    expect(result.warnings).toEqual([]);
    const summary = formatAgroMarginSummary(FULL, result);
    expect(summary).not.toContain('Advertencias');
  });
});
