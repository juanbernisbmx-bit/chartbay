export type Severity = 'critico' | 'advertencia' | 'informativo';
export type ValidationKind = 'required' | 'number-range' | 'date-range' | 'digits' | 'allowed' | 'date-order' | 'sum' | 'age';
/** Declarative conditions only. No expression evaluation or executable recipes. */
export interface ValidationRule {
  id: string;
  label: string;
  kind: ValidationKind;
  column: string;
  severity: Severity;
  min?: number;
  max?: number;
  from?: string;
  to?: string;
  length?: number;
  values?: string[];
  other?: string;
  components?: string[];
  tolerance?: number;
  asOf?: string;
}
export interface CategoryMapping { column: string; from: string[]; to: string }
export interface OutlierOptions {
  method: 'none' | 'iqr' | 'zscore' | 'percentile';
  factor: number;
  lower: number;
  upper: number;
  columns: string[];
}
export const DEFAULT_OUTLIERS: OutlierOptions = { method: 'none', factor: 1.5, lower: 1, upper: 99, columns: [] };
export interface Issue {
  code: string; column: string; label: string; severity: Severity; count: number;
  examples: { row: number; value: string; detail?: string }[];
}
export interface QualitySummary {
  rows: number;
  errors: number;
  rowsWithErrors: number;
  severity: Record<Severity, number>;
  issues: Issue[];
}
export interface NumericDistribution {
  count: number; min: number | null; max: number | null; mean: number | null;
  median: number | null; q1: number | null; q3: number | null; sd: number | null;
  lowerPercentile: number | null; upperPercentile: number | null;
}
export interface AdvancedProfile extends NumericDistribution {
  firstDate: string | null; lastDate: string | null;
  nullPercent: number;
  topCategories: { value: string; count: number }[];
  categoriesExact: boolean;
  outliers: number;
}
export interface CategorySuggestion { column: string; variants: { value: string; count: number }[]; canonical: string; reason: string }
