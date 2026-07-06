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
  AgroSensitivityMatrix,
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

function requirePct(value: number, label: string): void {
  requireNonNegative(value, label);
  if (value > 100) {
    throw new Error(`"${label}" es un porcentaje del ingreso bruto: tiene que estar entre 0 y 100 (recibido: ${value}).`);
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
  if (input.harvestCostPctRevenue !== undefined) {
    requirePct(input.harvestCostPctRevenue, 'harvestCostPctRevenue');
  }
  if (input.sellingCostPctRevenue !== undefined) {
    requirePct(input.sellingCostPctRevenue, 'sellingCostPctRevenue');
  }
  if (input.rentQqSojaPerHa !== undefined) {
    requireNonNegative(input.rentQqSojaPerHa, 'rentQqSojaPerHa');
  }
  if (input.sojaReferencePriceUsdPerTon !== undefined) {
    requireNonNegative(input.sojaReferencePriceUsdPerTon, 'sojaReferencePriceUsdPerTon');
  }
  if ((input.rentQqSojaPerHa ?? 0) > 0 && input.sojaReferencePriceUsdPerTon === undefined && input.crop !== 'soja') {
    throw new Error(
      'El alquiler en qq de soja necesita un precio de referencia: indicá sojaReferencePriceUsdPerTon ' +
      '(sólo se infiere del precio esperado cuando el cultivo es soja).'
    );
  }
}

// Fracción del ingreso bruto que se van en cosecha + comercialización (0 a 2,
// pero validado a ≤ 1 por campo). Se descuenta del precio efectivo.
function revenueProportionalFraction(input: AgroMarginInput): number {
  return ((input.harvestCostPctRevenue ?? 0) + (input.sellingCostPctRevenue ?? 0)) / 100;
}

// Alquiler en qq de soja valuado en USD/ha. Para cultivo soja sin precio de
// referencia explícito se usa el precio esperado del propio input (con la
// consecuencia deliberada de que en los escenarios el alquiler se revalúa al
// precio del escenario: un contrato en qq es exactamente eso, exposición al
// precio de la soja).
function rentQqValueUsdPerHa(input: AgroMarginInput): number {
  const qq = input.rentQqSojaPerHa ?? 0;
  if (qq === 0) return 0;
  const sojaPrice = input.sojaReferencePriceUsdPerTon ??
    (input.crop === 'soja' ? input.expectedPriceUsdPerTon : 0);
  return qq * 0.1 * sojaPrice; // 1 qq = 0,1 tn
}

// Suma de todos los costos fijos por hectárea (incluye alquiler en qq valuado).
function fixedCostPerHa(input: AgroMarginInput): number {
  const perHa = COST_FIELDS_PER_HA.reduce((sum, field) => sum + (input[field] ?? 0), 0);
  return perHa + rentQqValueUsdPerHa(input);
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

// Costo total = costos fijos por ha × hectáreas + flete × toneladas totales
// + (cosecha % + comercialización %) × ingreso bruto.
export function calculateAgroTotalCost(input: AgroMarginInput): number {
  validateAgroMarginInput(input);
  const totalTons = input.hectares * yieldToTonsPerHa(input.expectedYield, input.yieldUnit);
  const freight = (input.freightCostUsdPerTon ?? 0) * totalTons;
  const revenueShare = revenueProportionalFraction(input) * calculateAgroRevenue(input);
  return fixedCostPerHa(input) * input.hectares + freight + revenueShare;
}

// Margen bruto = ingreso bruto − costo total.
export function calculateAgroGrossMargin(input: AgroMarginInput): number {
  return calculateAgroRevenue(input) - calculateAgroTotalCost(input);
}

// Margen por hectárea = margen bruto / hectáreas.
export function calculateAgroMarginPerHectare(input: AgroMarginInput): number {
  return calculateAgroGrossMargin(input) / input.hectares;
}

// Rinde de indiferencia resuelto algebraicamente. Con a = 1 − fracción del
// ingreso que se llevan cosecha/comercialización, el margen por ha es
//   y·p·a − flete·y − costo_fijo_ha = 0  →  y* = costo_fijo_ha / (p·a − flete)
// Los costos que escalan con el rinde (flete, % del ingreso) van del lado del
// precio efectivo: NO se congelan al rinde esperado (la versión anterior sí
// lo hacía con el flete, y el punto de indiferencia quedaba corrido).
// Null si el precio efectivo neto de flete es ≤ 0 (ningún rinde cubre costos).
export function calculateBreakEvenYield(input: AgroMarginInput): number | null {
  validateAgroMarginInput(input);
  const a = 1 - revenueProportionalFraction(input);
  const effectivePrice = input.expectedPriceUsdPerTon * a - (input.freightCostUsdPerTon ?? 0);
  if (effectivePrice <= 0) return null;
  const breakEvenTnPerHa = fixedCostPerHa(input) / effectivePrice;
  return breakEvenTnPerHa / TONS_PER_UNIT[input.yieldUnit];
}

// Precio de indiferencia: y·p·a = costo_fijo_ha + flete·y
//   →  p* = (costo_fijo_ha + flete·y) / (y·a)
// Null si el rinde esperado es 0 o si cosecha+comercialización se llevan el
// 100% del ingreso (ningún precio indiferencia).
// Nota: si el alquiler está en qq de soja y el cultivo es soja sin precio de
// referencia, el alquiler queda valuado al precio ESPERADO (no al de
// indiferencia); es la lectura correcta de "¿a qué precio empato, dado lo que
// ya pacté de alquiler al valor actual de la soja?".
export function calculateBreakEvenPrice(input: AgroMarginInput): number | null {
  validateAgroMarginInput(input);
  const a = 1 - revenueProportionalFraction(input);
  const yieldTnHa = yieldToTonsPerHa(input.expectedYield, input.yieldUnit);
  if (yieldTnHa <= 0 || a <= 0) return null;
  return (fixedCostPerHa(input) + (input.freightCostUsdPerTon ?? 0) * yieldTnHa) / (yieldTnHa * a);
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

// ── Matriz de sensibilidad precio × rinde ───────────────────────────────────
//
// Tabla de doble entrada estándar de los informes de márgenes: margen/ha para
// combinaciones de precio y rinde alrededor del escenario base. A diferencia
// de los escenarios (que mueven precio y rinde JUNTOS), acá cada celda es una
// combinación independiente — que es como se lee el riesgo en la práctica.

export interface AgroSensitivityOptions {
  steps?: number;      // celdas por eje (impar recomendado; default 5)
  spreadPct?: number;  // amplitud del eje en % del valor base (default 20)
}

export function buildAgroSensitivityMatrix(
  input: AgroMarginInput,
  options: AgroSensitivityOptions = {}
): AgroSensitivityMatrix {
  validateAgroMarginInput(input);
  const steps = options.steps ?? 5;
  const spreadPct = options.spreadPct ?? 20;
  if (!Number.isInteger(steps) || steps < 2) {
    throw new Error(`"steps" tiene que ser un entero ≥ 2 (recibido: ${options.steps}).`);
  }
  requireNonNegative(spreadPct, 'spreadPct');

  const factors = Array.from({ length: steps }, (_, i) =>
    1 - spreadPct / 100 + (2 * spreadPct / 100) * (i / (steps - 1))
  );

  const priceStepsUsdPerTon = factors.map(f => input.expectedPriceUsdPerTon * f);
  const yieldSteps = factors.map(f => input.expectedYield * f);

  const marginPerHaUsd = yieldSteps.map(yieldValue =>
    priceStepsUsdPerTon.map(price => {
      const cellInput: AgroMarginInput = {
        ...input,
        expectedYield: yieldValue,
        expectedPriceUsdPerTon: price,
      };
      return calculateAgroGrossMargin(cellInput) / input.hectares;
    })
  );

  return {
    priceStepsUsdPerTon,
    yieldSteps,
    yieldUnit: input.yieldUnit,
    marginPerHaUsd,
  };
}

// Resultado completo del simulador: margen, puntos de indiferencia,
// escenarios, matriz de sensibilidad y warnings.
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
    (input.freightCostUsdPerTon ?? 0) > 0 ||
    (input.harvestCostPctRevenue ?? 0) > 0 ||
    (input.sellingCostPctRevenue ?? 0) > 0 ||
    (input.rentQqSojaPerHa ?? 0) > 0;
  if (!hasAnyCost) {
    warnings.push('No se cargó ningún costo: el margen bruto coincide con el ingreso bruto.');
  }
  if ((input.harvestCostPctRevenue ?? 0) === 0 && (input.sellingCostPctRevenue ?? 0) === 0 && hasAnyCost) {
    warnings.push(
      'No se cargó cosecha ni gastos de comercialización: en la práctica suelen ser 15-20% del ' +
      'ingreso bruto, y sin ellos el margen queda sobreestimado.'
    );
  }
  if (revenueProportionalFraction(input) >= 1) {
    warnings.push(
      'Cosecha + comercialización se llevan el 100% (o más) del ingreso bruto: los puntos de ' +
      'indiferencia no existen con esa estructura de costos.'
    );
  }
  if (input.crop === 'soja' && (input.rentQqSojaPerHa ?? 0) > 0 && input.sojaReferencePriceUsdPerTon === undefined) {
    warnings.push(
      'El alquiler en qq de soja se valuó al precio esperado del cultivo (no se indicó precio de referencia).'
    );
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
    sensitivity: buildAgroSensitivityMatrix(input),
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
// Tabla de sensibilidad en texto plano de ancho fijo (filas = rinde,
// columnas = precio). Exportada aparte para poder testearla sola.
export function formatAgroSensitivityMatrix(matrix: AgroSensitivityMatrix): string {
  const unitLabel = YIELD_UNIT_LABELS[matrix.yieldUnit];
  const colWidth = 12;
  const pad = (text: string): string => text.padStart(colWidth);

  const header =
    pad(`rinde ${unitLabel}`) +
    matrix.priceStepsUsdPerTon.map(p => pad(`${p.toFixed(0)} USD/tn`)).join('');
  const rows = matrix.yieldSteps.map((yieldValue, i) =>
    pad(yieldValue.toFixed(0)) +
    matrix.marginPerHaUsd[i].map(m => pad(m.toFixed(0))).join('')
  );
  return [header, ...rows].join('\n');
}

export function formatAgroMarginSummary(input: AgroMarginInput, result: AgroMarginResult): string {
  const inputUnitLabel = YIELD_UNIT_LABELS[input.yieldUnit];
  const breakEvenUnitLabel = YIELD_UNIT_LABELS[result.breakEvenYieldUnit];

  const revenueShareLines: string[] = [];
  if ((input.harvestCostPctRevenue ?? 0) > 0) {
    revenueShareLines.push(`Cosecha: ${input.harvestCostPctRevenue!.toFixed(1)}% del ingreso bruto`);
  }
  if ((input.sellingCostPctRevenue ?? 0) > 0) {
    revenueShareLines.push(`Gastos de comercialización: ${input.sellingCostPctRevenue!.toFixed(1)}% del ingreso bruto`);
  }
  if ((input.rentQqSojaPerHa ?? 0) > 0) {
    revenueShareLines.push(`Alquiler: ${input.rentQqSojaPerHa} qq de soja/ha`);
  }

  const lines = [
    'ChartBay Agro — Resumen del simulador de margen bruto',
    '(Cálculo del vertical Agro; no proviene del motor econométrico.)',
    '',
    `Cultivo: ${input.crop}`,
    `Hectáreas: ${input.hectares}`,
    `Rinde esperado: ${input.expectedYield} ${inputUnitLabel} (${result.yieldTnHa.toFixed(3)} tn/ha)`,
    `Precio esperado: ${input.expectedPriceUsdPerTon.toFixed(2)} USD/tn`,
    ...revenueShareLines,
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
    '',
    'Sensibilidad precio × rinde (margen/ha en USD)',
    formatAgroSensitivityMatrix(result.sensitivity),
    ...(result.warnings.length > 0 ? ['', 'Advertencias', ...result.warnings.map(w => `  - ${w}`)] : []),
    '',
    'Datos con fines educativos; no constituye asesoramiento financiero ni recomendación agronómica.',
  ];

  return lines.join('\n');
}
