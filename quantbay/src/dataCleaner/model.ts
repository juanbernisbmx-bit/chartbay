import type { ValidationRule, CategoryMapping, OutlierOptions, QualitySummary, AdvancedProfile, CategorySuggestion } from './advancedTypes';
/** Conservative, reversible rules: uncertain/invalid values are preserved by default. */
export type ColumnType = 'texto' | 'número' | 'fecha' | 'identificador' | 'CUIT/CUIL';
export interface Rules {
  normalizeHeaders: boolean;
  trimText: boolean;
  normalizeIdentifiers: boolean;
  dropDuplicates: boolean;
  missing: 'keep' | 'blank' | 'drop';
  invalid: 'keep' | 'blank';
  types: Record<number, ColumnType>;
  custom?: ValidationRule[];
  categories?: CategoryMapping[];
  outliers?: OutlierOptions;
}
export const DEFAULT_RULES: Rules = {
  normalizeHeaders: true, trimText: true, normalizeIdentifiers: true, dropDuplicates: false,
  missing: 'keep', invalid: 'keep', types: {},
};
export interface Row { n: number; cells: string[]; duplicateOf?: number }
export interface Profile {
  name: string; key?: string; type: ColumnType; decimal: '.' | ','; ambiguous: boolean;
  present: number; missing: number; invalid: number; dirty: number;
  invalidExamples: { row: number; value: string }[];
  advanced?: AdvancedProfile;
  unique: number; uniqueCapped: boolean; min: number | null; max: number | null; mean: number | null;
}
export interface Change { row: number; column: string; before: string; after: string; reason: string }
export interface Review {
  profiles: Profile[]; rowsIn: number; rowsOut: number; duplicates: number;
  changedCells: number; removedRows: number; preview: Change[];
  rules: Rules; previewLimit: number;
  before?: QualitySummary; after?: QualitySummary;
  categorySuggestions?: CategorySuggestion[];
}
export interface Source { name: string; size: number; sheet?: string; importedAt: string; warnings: string[]; headerRow?: number; originalHeaders?: string[] }
export function cleanText(value: string): string {
  return value.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\s\u00A0]+/g, ' ').trim();
}
export function isMissing(value: string): boolean {
  return /^(?:|na|n\/a|n\/d|s\/d|null|none|nan|#n\/a|-)$/i.test(cleanText(value));
}
export function validTaxId(value: string): boolean {
  const text = cleanText(value);
  if (!/^(?:\d{11}|\d{2}-\d{8}-\d)$/.test(text)) return false;
  const digits = text.replace(/-/g, '');
  if (!/^(20|23|24|27|30|33|34)/.test(digits)) return false;
  const sum = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2].reduce((s, w, i) => s + w * Number(digits[i]), 0);
  const check = 11 - sum % 11;
  return check !== 10 && (check === 11 ? 0 : check) === Number(digits[10]);
}
export function parseNumeric(value: string, decimal: '.' | ','): number | null {
  let text = cleanText(value);
  // Preserve identifiers and reject malformed thousands groups rather than stripping punctuation.
  const pattern = decimal === ','
    ? /^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?(?:[eE][+-]?\d+)?$/
    : /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  if (!pattern.test(text)) return null;
  text = decimal === ',' ? text.replace(/\./g, '').replace(',', '.') : text.replace(/,/g, '');
  const result = Number(text);
  return Number.isFinite(result) ? result : null;
}
export function validDate(value: string): boolean {
  const text = cleanText(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const local = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!iso && !local) return false;
  const [y, m, d] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : [Number(local![3]), Number(local![2]), Number(local![1])];
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
export function inferProfiles(headers: string[], sample: Row[], overrides: Rules['types']): Profile[] {
  return headers.map((name, index) => {
    const values = sample.map(row => row.cells[index] ?? '').filter(v => !isMissing(v));
    const commaVotes = values.filter(v => /,\d{1,2}$/.test(v) || /\.\d{3},\d+$/.test(v)).length;
    const dotVotes = values.filter(v => /\.\d{1,2}$/.test(v) || /,\d{3}\.\d+$/.test(v)).length;
    const decimal = commaVotes > dotVotes ? ',' : '.';
    const ambiguous = values.some(v => /^\d{1,3}[.,]\d{3}$/.test(v)) && !commaVotes && !dotVotes;
    let type: ColumnType = 'texto';
    if (/(?:cuit|cuil)/i.test(name)) type = 'CUIT/CUIL';
    else if (/(?:^|[ _-])(?:id|código|codigo|dni|cp|postal|tel[eé]fono)(?:$|[ _-])/i.test(name)
      || values.some(v => /^0\d+$/.test(v) || /^\d{16,}$/.test(v))) type = 'identificador';
    else if (values.length && values.filter(v => validDate(v)).length / values.length >= .8) type = 'fecha';
    else if (values.length && values.filter(v => parseNumeric(v, decimal) !== null).length / values.length >= .8) type = 'número';
    return { name, type: overrides[index] ?? type, decimal, ambiguous, present: 0, missing: 0,
      invalid: 0, dirty: 0, invalidExamples: [], unique: 0, uniqueCapped: false, min: null, max: null, mean: null };
  });
}
export function invalidValue(value: string, profile: Profile): boolean {
  if (isMissing(value)) return false;
  if (profile.type === 'CUIT/CUIL') return !validTaxId(value);
  if (profile.type === 'número') return parseNumeric(value, profile.decimal) === null;
  if (profile.type === 'fecha') return !validDate(value);
  return false;
}
export function transform(row: Row, profiles: Profile[], rules: Rules): { cells: string[] | null; changes: Change[] } {
  const reason = rules.dropDuplicates && row.duplicateOf ? `Duplicada de la fila ${row.duplicateOf}`
    : rules.missing === 'drop' && row.cells.some(isMissing) ? 'Fila con faltantes' : '';
  if (reason) return { cells: null, changes: [{ row: row.n, column: '(fila)', before: JSON.stringify(row.cells), after: '(eliminar)', reason }] };
  const changes: Change[] = [];
  const cells = row.cells.map((before, i) => {
    let after = before;
    const reasons: string[] = [];
    if (rules.trimText && cleanText(after) !== after) { after = cleanText(after); reasons.push('Normalizar espacios y Unicode'); }
    if (rules.missing === 'blank' && isMissing(after) && after !== '') { after = ''; reasons.push('Marcador de faltante a vacío'); }
    if (rules.invalid === 'blank' && invalidValue(before, profiles[i])) { after = ''; reasons.push('Tipo o identificador inválido a vacío'); }
    if (rules.normalizeIdentifiers && profiles[i].type === 'CUIT/CUIL' && validTaxId(after)) {
      const normalized = cleanText(after).replace(/-/g, '');
      if (normalized !== after) { after = normalized; reasons.push('CUIT/CUIL válido sin guiones'); }
    }
    const mapping = rules.categories?.find(group => group.column === (profiles[i].key ?? profiles[i].name) && group.from.includes(before));
    if (mapping && after !== mapping.to) { after = mapping.to; reasons.push('Agrupación de categorías aprobada'); }
    if (before !== after) changes.push({ row: row.n, column: profiles[i].name, before, after, reason: reasons.join('; ') });
    return after;
  });
  return { cells, changes };
}
export function csvLine(cells: string[], safeForExcel = false): string {
  return cells.map(cell => {
    // Spreadsheet formula escaping is opt-in and recorded in the export audit.
    const value = safeForExcel && /^[\s]*[=+@-]/.test(cell) ? "'" + cell : cell;
    return /[",\r\n]/.test(value) ? '"' + value.replace(/"/g, '""') + '"' : value;
  }).join(',') + '\r\n';
}
