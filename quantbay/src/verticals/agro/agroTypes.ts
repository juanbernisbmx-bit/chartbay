// ChartBay Agro — tipos base de la capa vertical agropecuaria.
//
// Principio arquitectónico: este vertical NO reimplementa el motor
// econométrico. Consume los módulos core existentes (regression.ts,
// functionalForms.ts, csvParser.ts, etc.) y sólo agrega contexto agro:
// detección de columnas, presets de modelos, datasets de ejemplo,
// simulador de margen e interpretación agropecuaria.
//
// Este archivo sólo define tipos: sin lógica pesada y sin dependencias
// circulares (importa únicamente tipos del core).

import type { FunctionalForm } from '../../functionalForms';

export type AgroCrop =
  | 'soja'
  | 'maiz'
  | 'trigo'
  | 'girasol'
  | 'sorgo'
  | 'cebada'
  | 'otro';

export type AgroModelType =
  | 'yield'
  | 'price'
  | 'margin'
  | 'production';

export type AgroColumnRole =
  | 'crop'
  | 'season'
  | 'province'
  | 'region'
  | 'yield'
  | 'rainfall'
  | 'temperature'
  | 'price'
  | 'cost'
  | 'margin'
  | 'production'
  | 'area_planted'
  | 'area_harvested'
  | 'exchange_rate'
  | 'freight'
  | 'rent'
  | 'fertilizer'
  | 'seed'
  | 'agrochemical'
  | 'unknown';

// ── Detección de columnas ────────────────────────────────────────────────────

export interface AgroDetectedColumn {
  original: string;            // header tal como vino en el CSV
  normalized: string;          // header normalizado (minúsculas, sin acentos, separadores → _)
  role: AgroColumnRole;
  confidence: number;          // 0 a 1 (1 = match exacto con un alias conocido)
  matchedAlias: string | null; // alias normalizado que disparó la detección
}

export interface AgroColumnDetectionResult {
  columns: AgroDetectedColumn[];
  // rol → headers ORIGINALES que lo matchearon (no incluye 'unknown')
  byRole: Partial<Record<AgroColumnRole, string[]>>;
  warnings: string[];
}

// ── Presets de modelos ───────────────────────────────────────────────────────

export interface AgroModelPreset {
  id: string;
  type: AgroModelType;
  label: string;
  objective: string;
  yRoles: AgroColumnRole[];      // roles candidatos a variable dependiente
  xRoles: AgroColumnRole[];      // roles candidatos a regresores
  // Al menos uno de estos roles tiene que estar presente entre las X para
  // sugerir el preset (evita sugerencias vacías tipo "precio ~ campaña").
  coreXRoles: AgroColumnRole[];
  suggestedForm: FunctionalForm;
}

export interface AgroModelPresetSuggestion {
  preset: AgroModelPreset;
  score: number;                 // 0 a 1, mayor = más completo
  yColumn: string;               // header original elegido como Y
  xColumns: string[];            // headers originales candidatos a X
  reason: string;                // por qué se sugiere
  missingRoles: AgroColumnRole[]; // roles X del preset que no se detectaron
}

// ── Simulador de margen ──────────────────────────────────────────────────────

export type AgroYieldUnit = 'kg_ha' | 'qq_ha' | 'tn_ha';

export interface AgroMarginInput {
  crop: AgroCrop;
  hectares: number;
  expectedYield: number;
  yieldUnit: AgroYieldUnit;
  expectedPriceUsdPerTon: number;
  seedCostUsdPerHa?: number;
  fertilizerCostUsdPerHa?: number;
  agrochemicalCostUsdPerHa?: number;
  laborCostUsdPerHa?: number;
  freightCostUsdPerTon?: number;
  rentCostUsdPerHa?: number;
  otherCostUsdPerHa?: number;
}

export interface AgroMarginScenario {
  id: 'pesimista' | 'base' | 'optimista';
  label: string;
  yieldTnHa: number;             // rinde del escenario, en tn/ha
  priceUsdPerTon: number;        // precio del escenario
  revenueUsd: number;
  totalCostUsd: number;
  grossMarginUsd: number;
  marginPerHectareUsd: number;
}

export interface AgroMarginResult {
  crop: AgroCrop;
  hectares: number;
  yieldTnHa: number;             // rinde esperado convertido a tn/ha
  totalTons: number;
  revenueUsd: number;
  totalCostUsd: number;
  grossMarginUsd: number;
  marginPerHectareUsd: number;
  // Rinde de indiferencia expresado en la MISMA unidad del input original.
  breakEvenYield: number | null;
  breakEvenYieldUnit: AgroYieldUnit;
  breakEvenPriceUsdPerTon: number | null;
  scenarios: AgroMarginScenario[];
  warnings: string[];
}

// ── Interpretación agro ──────────────────────────────────────────────────────

export interface AgroInterpretationContext {
  form: FunctionalForm;
  targetColumn: string;                       // nombre de la variable Y
  targetRole: AgroColumnRole;                 // rol agro de la Y
  columnRoles: Record<string, AgroColumnRole>; // regresor → rol agro
  crop?: AgroCrop;
}

export interface AgroInterpretation {
  executiveSummary: string;
  coefficientReadings: string[];
  agroReading: string;
  warnings: string[];
  limitations: string[];
}

// ── Datasets de ejemplo ──────────────────────────────────────────────────────

export interface AgroExampleDataset {
  id: string;
  name: string;
  description: string;
  crop: AgroCrop;
  synthetic: true;               // siempre true: no usamos datos reales todavía
  columns: string[];
  rows: Array<Record<string, string | number>>;
  suggestedPresetId?: string;
}

// Opciones del generador de datasets sintéticos grandes (muchas más filas que
// los datasets de ejemplo fijos de arriba). Sirve para probar el flujo con un
// volumen de datos parecido al de fuentes reales (ver agroDataCatalog.ts),
// sin descargar ni fabricar datos reales.
export interface AgroLargeSyntheticDatasetOptions {
  crop?: AgroCrop;
  seasonsCount?: number;            // cantidad de campañas simuladas
  provinces?: string[];             // nombres de provincia a simular
  departmentsPerProvince?: number;  // departamentos sintéticos por provincia
  includeWeather?: boolean;         // agrega lluvia_total_mm y temperatura_media
  includePrices?: boolean;          // agrega precio_usd_tn
  includeCosts?: boolean;           // agrega costo_usd_ha
  seed?: number;                    // semilla del PRNG determinista (reproducible)
}

// ── Catálogo de fuentes de datos agro (sólo referencia informativa) ────────
//
// loadMethod siempre es 'manual_csv': ChartBay Agro todavía NO descarga ni
// integra ninguna API externa. El catálogo sólo documenta de dónde vendrían
// datos reales y qué preset conviene usar con cada uno.

export interface AgroDataSource {
  id: string;
  name: string;
  provider: string;                 // organismo/institución de origen
  granularity: string[];             // dimensiones de desagregación del dataset
  variables: string[];               // variables típicamente disponibles
  recommendedFor: AgroModelType[];   // qué tipo(s) de modelo agro conviene aplicar
  loadMethod: 'manual_csv';
  notes: string;
}

// ── Templates de CSV recomendados ───────────────────────────────────────────

export interface AgroCsvTemplate {
  id: string;
  name: string;
  description: string;
  requiredColumns: string[];
  optionalColumns: string[];
  exampleRows: Array<Record<string, string | number>>;
  recommendedModelType: AgroModelType;
}

// ── Capacidad del modelo según n (observaciones) y k (regresores) ─────────

export type AgroModelCapacityLevel = 'safe' | 'warning' | 'unsafe';

export interface AgroModelCapacityAssessment {
  level: AgroModelCapacityLevel;
  maxRecommendedX: number;   // cantidad de X recomendada dado rowCount
  messages: string[];
}
