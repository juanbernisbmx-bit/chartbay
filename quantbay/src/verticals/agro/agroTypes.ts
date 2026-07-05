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
