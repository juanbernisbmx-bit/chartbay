// ChartBay Agro — simulador de margen bruto agrícola.
//
// Módulo 100% puro: no depende del motor econométrico, del DOM ni de I/O.
// Todas las funciones trabajan en USD; el rinde se convierte internamente a
// toneladas por hectárea.
//
// Convención de errores (la misma del motor: ver regression.ts): input
// estructuralmente inválido (NaN, Infinity, negativos, hectáreas <= 0) lanza
// Error con mensaje pedagógico en español. Las situaciones dudosas pero
// calculables (precio 0, rinde 0, sin costos cargados) se informan como
// warnings dentro del resultado.

import type {
  AgroMarginInput,
  AgroMarginResult,
  AgroMarginScenario,
  AgroYieldUnit,
} from './agroTypes';

const TONS_PER_UNIT: Record<AgroYieldUnit, number> = {
  kg_ha: 1 / 1000, // 1000 kg = 1 tn
  qq_ha: 0.1,      // 1 quintal = 100 kg
  tn_ha: 1,
};

const COST_FIELDS_PER_HA = [
  'seedCostUsdPerHa',
  'fertilizerCostUsdPerHa',
  'agrochemicalCostUsdPerHa',
  'laborCostUsdPerHa',
  'rentCostUsdPerHa',
  'otherCostUsdPerHa',
] as const;

function requireFinite(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`"${label}" tiene que ser un número finito (recibido: ${value}).`);
  }
}

function requireNonNegative(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0) {
    throw new Error(`"${label}" no puede ser negativo (recibido: ${value}).`);
  }
}

// Valida el input completo. Lanza Error ante datos estructuralmente inválidos.
function validateAgroMarginInput(input: AgroMarginInput): void {
  requireFinite(input.hectares, 'hectáreas');
  if (input.hectares <= 0) {
    throw new Error(`Las hectáreas tienen que ser mayores a 0 (recibido: ${input.hectares}).`);
  }
  requireNonNegative(input.expectedYield, 'rinde esperado');
  requireNonNegative(input.expectedPriceUsdPerTon, 'precio esperado (USD/tn)');
  if (!(input.yieldUnit in TONS_PER_UNIT)) {
    throw new Error(`Unidad de rinde desconocida: "${String(input.yieldUnit)}". Usá kg_ha, qq_ha o tn_ha.`);
  }
  for (const field of COST_FIELDS_PER_HA) {
    const value = input[field];
    if (value !== undefined) requireNonNegative(value, field);
  }
  if (input.freightCostUsdPerTon !== undefined) {
    requireNonNegative(input.freightCostUsdPerTon, 'freightCostUsdPerTon');
  }
}

// Rinde esperado convertido a toneladas por hectárea.
export function yieldToTonsPerHa(expectedYield: number, unit: AgroYieldUnit): number {
  return expectedYield * TONS_PER_UNIT[unit];
}

// Ingreso bruto = hectáreas × tn/ha × precio USD/tn.
export function calculateAgroRevenue(input: AgroMarginInput): number {
  validateAgroMarginInput(input);
  const tnPerHa = yieldToTonsPerHa(input.expectedYield, input.yieldUnit);
  return input.hectares * tnPerHa * input.expectedPriceUsdPerTon;
}

// Costo total = costos por ha × hectáreas + flete × toneladas totales.
export function calculateAgroTotalCost(input: AgroMarginInput): number {
  validateAgroMarginInput(input);
  const costsPerHa = COST_FIELDS_PER_HA.reduce((sum, field) => sum + (input[field] ?? 0), 0);
  const totalTons = input.hectares * yieldToTonsPerHa(input.expectedYield, input.yieldUnit);
  const freight = (input.freightCostUsdPerTon ?? 0) * totalTons;
  return costsPerHa * input.hectares + freight;
}

// Margen bruto = ingreso bruto − costo total.
export function calculateAgroGrossMargin(input: AgroMarginInput): number {
  return calculateAgroRevenue(input) - calculateAgroTotalCost(input);
}

// Margen por hectárea = margen bruto / hectáreas.
export function calculateAgroMarginPerHectare(input: AgroMarginInput): number {
  return calculateAgroGrossMargin(input) / input.hectares;
}

// Rinde de indiferencia = costo total / (hectáreas × precio USD/tn),
// convertido a la unidad original del input. Null si el precio es 0
// (no hay rinde que cubra costos si el grano no vale nada).
export function calculateBreakEvenYield(input: AgroMarginInput): number | null {
  const totalCost = calculateAgroTotalCost(input);
  const denominator = input.hectares * input.expectedPriceUsdPerTon;
  if (denominator <= 0) return null;
  const breakEvenTnPerHa = totalCost / denominator;
  return breakEvenTnPerHa / TONS_PER_UNIT[input.yieldUnit];
}

// Precio de indiferencia = costo total / toneladas totales.
// Null si el rinde esperado es 0 (sin producción no hay precio que indiferencie).
export function calculateBreakEvenPrice(input: AgroMarginInput): number | null {
  const totalCost = calculateAgroTotalCost(input);
  const totalTons = input.hectares * yieldToTonsPerHa(input.expectedYield, input.yieldUnit);
  if (totalTons <= 0) return null;
  return totalCost / totalTons;
}

interface ScenarioSpec {
  id: AgroMarginScenario['id'];
  label: string;
  factor: number; // multiplicador aplicado a rinde Y precio
}

const SCENARIO_SPECS: ScenarioSpec[] = [
  { id: 'pesimista', label: 'Pesimista (−10% rinde y −10% precio)', factor: 0.9 },
  { id: 'base', label: 'Base (rinde y precio esperados)', factor: 1 },
  { id: 'optimista', label: 'Optimista (+10% rinde y +10% precio)', factor: 1.1 },
];

// Corre los 3 escenarios (pesimista / base / optimista) sobre el input.
export function runAgroMarginScenarios(input: AgroMarginInput): AgroMarginScenario[] {
  validateAgroMarginInput(input);
  return SCENARIO_SPECS.map(spec => {
    const scenarioInput: AgroMarginInput = {
      ...input,
      expectedYield: input.expectedYield * spec.factor,
      expectedPriceUsdPerTon: input.expectedPriceUsdPerTon * spec.factor,
    };
    const revenue = calculateAgroRevenue(scenarioInput);
    const totalCost = calculateAgroTotalCost(scenarioInput);
    const grossMargin = revenue - totalCost;
    return {
      id: spec.id,
      label: spec.label,
      yieldTnHa: yieldToTonsPerHa(scenarioInput.expectedYield, scenarioInput.yieldUnit),
      priceUsdPerTon: scenarioInput.expectedPriceUsdPerTon,
      revenueUsd: revenue,
      totalCostUsd: totalCost,
      grossMarginUsd: grossMargin,
      marginPerHectareUsd: grossMargin / scenarioInput.hectares,
    };
  });
}

// Resultado completo del simulador: margen, puntos de indiferencia,
// escenarios y warnings.
export function calculateAgroMargin(input: AgroMarginInput): AgroMarginResult {
  validateAgroMarginInput(input);

  const warnings: string[] = [];
  if (input.expectedYield === 0) {
    warnings.push('El rinde esperado es 0: no hay producción, el margen es el costo con signo negativo.');
  }
  if (input.expectedPriceUsdPerTon === 0) {
    warnings.push('El precio esperado es 0 USD/tn: el ingreso bruto es nulo.');
  }
  const hasAnyCost =
    COST_FIELDS_PER_HA.some(field => (input[field] ?? 0) > 0) ||
    (input.freightCostUsdPerTon ?? 0) > 0;
  if (!hasAnyCost) {
    warnings.push('No se cargó ningún costo: el margen bruto coincide con el ingreso bruto.');
  }

  const yieldTnHa = yieldToTonsPerHa(input.expectedYield, input.yieldUnit);
  const revenue = calculateAgroRevenue(input);
  const totalCost = calculateAgroTotalCost(input);
  const grossMargin = revenue - totalCost;
  const breakEvenYield = calculateBreakEvenYield(input);
  const breakEvenPrice = calculateBreakEvenPrice(input);

  if (grossMargin < 0) {
    warnings.push('El margen bruto del escenario base es negativo: los costos superan al ingreso esperado.');
  }

  return {
    crop: input.crop,
    hectares: input.hectares,
    yieldTnHa,
    totalTons: input.hectares * yieldTnHa,
    revenueUsd: revenue,
    totalCostUsd: totalCost,
    grossMarginUsd: grossMargin,
    marginPerHectareUsd: grossMargin / input.hectares,
    breakEvenYield,
    breakEvenYieldUnit: input.yieldUnit,
    breakEvenPriceUsdPerTon: breakEvenPrice,
    scenarios: runAgroMarginScenarios(input),
    warnings,
  };
}

const YIELD_UNIT_LABELS: Record<AgroYieldUnit, string> = {
  kg_ha: 'kg/ha',
  qq_ha: 'qq/ha',
  tn_ha: 'tn/ha',
};

// Resumen en texto plano del simulador de margen, para copiar al portapapeles
// o exportar como TXT. Toma el input tal como lo ingresó el usuario (para
// mostrar el rinde/precio en sus unidades originales) y el resultado ya
// calculado — no vuelve a calcular nada.
export function formatAgroMarginSummary(input: AgroMarginInput, result: AgroMarginResult): string {
  const inputUnitLabel = YIELD_UNIT_LABELS[input.yieldUnit];
  const breakEvenUnitLabel = YIELD_UNIT_LABELS[result.breakEvenYieldUnit];

  const lines = [
    'ChartBay Agro — Resumen del simulador de margen bruto',
    '(Cálculo del vertical Agro; no proviene del motor econométrico.)',
    '',
    `Cultivo: ${input.crop}`,
    `Hectáreas: ${input.hectares}`,
    `Rinde esperado: ${input.expectedYield} ${inputUnitLabel} (${result.yieldTnHa.toFixed(3)} tn/ha)`,
    `Precio esperado: ${input.expectedPriceUsdPerTon.toFixed(2)} USD/tn`,
    `Ingreso bruto: ${result.revenueUsd.toFixed(2)} USD`,
    `Costo total: ${result.totalCostUsd.toFixed(2)} USD`,
    `Margen bruto: ${result.grossMarginUsd.toFixed(2)} USD`,
    `Margen por hectárea: ${result.marginPerHectareUsd.toFixed(2)} USD/ha`,
    `Rinde de indiferencia: ${result.breakEvenYield === null ? 'N/D' : `${result.breakEvenYield.toFixed(2)} ${breakEvenUnitLabel}`}`,
    `Precio de indiferencia: ${result.breakEvenPriceUsdPerTon === null ? 'N/D' : `${result.breakEvenPriceUsdPerTon.toFixed(2)} USD/tn`}`,
    '',
    'Escenarios (±10% rinde y precio)',
    ...result.scenarios.map(scenario =>
      `  ${scenario.label}: rinde ${scenario.yieldTnHa.toFixed(3)} tn/ha, precio ${scenario.priceUsdPerTon.toFixed(2)} USD/tn, ` +
      `margen bruto ${scenario.grossMarginUsd.toFixed(2)} USD, margen/ha ${scenario.marginPerHectareUsd.toFixed(2)} USD/ha`
    ),
    ...(result.warnings.length > 0 ? ['', 'Advertencias', ...result.warnings.map(w => `  - ${w}`)] : []),
    '',
    'Datos con fines educativos; no constituye asesoramiento financiero ni recomendación agronómica.',
  ];

  return lines.join('\n');
}
