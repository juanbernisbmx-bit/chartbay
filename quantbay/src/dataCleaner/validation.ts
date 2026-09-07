import { cleanText, invalidValue, isMissing, parseNumeric, validDate, type Profile, type Row, type Rules } from './model';
import { DEFAULT_OUTLIERS, type Issue, type OutlierOptions, type QualitySummary, type Severity, type ValidationRule } from './advancedTypes';
const columnIndexes = new WeakMap<string[], Map<string, number>>();
function columnIndex(headers: string[], name: string): number {
  let indexes = columnIndexes.get(headers);
  if (!indexes) { indexes = new Map(headers.map((header, i) => [header, i])); columnIndexes.set(headers, indexes); }
  return indexes.get(name) ?? -1;
}
const severities: Severity[] = ['critico', 'advertencia', 'informativo'];
export function dateValue(value: string): number | null {
  if (!validDate(value)) return null;
  const parts = cleanText(value).split(/[/-]/).map(Number);
  const [year, month, day] = value.includes('/') ? [parts[2], parts[1], parts[0]] : parts;
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}
export function validateRules(rules: Rules, headers: string[]): void {
  if (JSON.stringify(rules).length * 2 > 1024 * 1024) throw new Error('La configuración supera el límite de 1 MiB.');
  const column = (name: unknown) => {
    if (typeof name !== 'string' || !headers.includes(name)) throw new Error(`La configuración usa una columna que no existe: ${String(name)}.`);
  };
  const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value);
  const custom = rules.custom ?? [];
  if (!Array.isArray(custom) || custom.length > 100) throw new Error('Máximo 100 reglas personalizadas.');
  const ids = new Set<string>();
  for (const r of custom) {
    if (!r || typeof r.id !== 'string' || !r.id || ids.has(r.id) || typeof r.label !== 'string' || r.label.length > 200 || !severities.includes(r.severity)) throw new Error('Regla inválida: revisá nombre, identificador y severidad.');
    ids.add(r.id); column(r.column);
    if (r.kind === 'number-range') {
      if ((r.min === undefined && r.max === undefined) || (r.min !== undefined && !finite(r.min)) || (r.max !== undefined && !finite(r.max)) || (r.min !== undefined && r.max !== undefined && r.min > r.max)) throw new Error('El rango numérico debe tener límites válidos y ordenados.');
    } else if (r.kind === 'date-range') {
      if (!r.from || !r.to || dateValue(r.from) === null || dateValue(r.to) === null || dateValue(r.from)! > dateValue(r.to)!) throw new Error('Ingresá dos fechas válidas y ordenadas.');
    } else if (r.kind === 'digits') {
      if (!Number.isInteger(r.length) || r.length! < 1 || r.length! > 1000) throw new Error('La longitud debe estar entre 1 y 1000 dígitos.');
    } else if (r.kind === 'allowed') {
      if (!Array.isArray(r.values) || !r.values.length || r.values.length > 1000 || r.values.some(v => typeof v !== 'string' || v.length > 500)) throw new Error('Ingresá entre 1 y 1000 valores permitidos, de hasta 500 caracteres.');
    } else if (r.kind === 'date-order') column(r.other);
    else if (r.kind === 'sum') {
      if (!Array.isArray(r.components) || !r.components.length || r.components.length > 100 || new Set(r.components).size !== r.components.length || r.components.includes(r.column)) throw new Error('Elegí componentes distintos del total, sin repetir.');
      r.components.forEach(column);
      if (!finite(r.tolerance) || r.tolerance! < 0) throw new Error('La tolerancia debe ser un número no negativo.');
    } else if (r.kind === 'age') {
      column(r.other);
      if (!r.asOf || dateValue(r.asOf) === null || !finite(r.tolerance) || r.tolerance! < 0) throw new Error('Edad: ingresá fecha de referencia y tolerancia válidas.');
    } else if (r.kind !== 'required') throw new Error('Tipo de regla desconocido.');
  }
  const mappings = rules.categories ?? [];
  if (!Array.isArray(mappings) || mappings.length > 100) throw new Error('Máximo 100 grupos de categorías.');
  const assigned = new Set<string>();
  for (const mapping of mappings) {
    column(mapping.column);
    if (typeof mapping.to !== 'string' || !mapping.to || mapping.to.length > 500 || !Array.isArray(mapping.from) || !mapping.from.length || mapping.from.length > 1000) throw new Error('Grupo de categorías inválido.');
    for (const value of mapping.from) {
      if (typeof value !== 'string' || value.length > 500) throw new Error('Categoría demasiado larga.');
      const key = JSON.stringify([mapping.column, value]);
      if (assigned.has(key)) throw new Error(`La categoría “${value}” tiene más de un destino.`);
      assigned.add(key);
    }
  }
  const o = rules.outliers ?? DEFAULT_OUTLIERS;
  if (!['none', 'iqr', 'zscore', 'percentile'].includes(o.method) || !finite(o.factor) || o.factor <= 0 || !finite(o.lower) || !finite(o.upper) || o.lower < 0 || o.upper > 100 || o.lower >= o.upper || !Array.isArray(o.columns)) throw new Error('Parámetros de outliers inválidos.');
  o.columns.forEach(column);
}
export function ruleFailure(rule: ValidationRule, cells: string[], profiles: Profile[], headers: string[]): string | null {
  const i = columnIndex(headers, rule.column), value = cells[i];
  const otherIndex = columnIndex(headers, rule.other ?? '');
  if (rule.kind === 'required') return isMissing(value) ? 'Dato obligatorio faltante' : null;
  // Missing operands fail conditions explicitly; blanks must not make invalid data pass.
  if (isMissing(value)) return 'Falta un dato necesario para evaluar la regla';
  const num = (index: number) => parseNumeric(cells[index] ?? '', profiles[index]?.decimal ?? '.');
  if (rule.kind === 'number-range') {
    const n = num(i);
    return n === null || (rule.min !== undefined && n < rule.min) || (rule.max !== undefined && n > rule.max) ? 'Fuera del rango numérico o valor no numérico' : null;
  }
  if (rule.kind === 'date-range') {
    const n = dateValue(value);
    return n === null || n < dateValue(rule.from!)! || n > dateValue(rule.to!)! ? 'Fecha inválida o fuera del intervalo' : null;
  }
  if (rule.kind === 'digits') return new RegExp(`^\\d{${rule.length}}$`).test(value) ? null : `Debe contener exactamente ${rule.length} dígitos, sin otros caracteres`;
  if (rule.kind === 'allowed') return rule.values!.includes(value) ? null : 'Valor fuera del catálogo permitido';
  if (rule.kind === 'date-order') {
    const end = dateValue(value), start = dateValue(cells[otherIndex]);
    return start === null || end === null || end < start ? 'Fecha inválida o anterior a la columna de referencia' : null;
  }
  if (rule.kind === 'sum') {
    const total = num(i), components = rule.components!.map(name => num(columnIndex(headers, name)));
    if (total === null || components.some(n => n === null)) return 'Total o componentes no numéricos';
    const sum = (components as number[]).reduce((a, b) => a + b, 0);
    return Math.abs(total - sum) > rule.tolerance! + Number.EPSILON * Math.max(1, Math.abs(total), Math.abs(sum)) * 8 ? `Total ${total}; suma ${sum}` : null;
  }
  const birthTime = dateValue(cells[otherIndex]), asOfTime = dateValue(rule.asOf!)!, age = num(i);
  if (birthTime === null || birthTime > asOfTime || age === null || age < 0) return 'Edad o fecha de nacimiento inválidas';
  const birth = new Date(birthTime), asOf = new Date(asOfTime);
  const birthdayPending = asOf.getUTCMonth() < birth.getUTCMonth() || (asOf.getUTCMonth() === birth.getUTCMonth() && asOf.getUTCDate() < birth.getUTCDate());
  const expected = asOf.getUTCFullYear() - birth.getUTCFullYear() - Number(birthdayPending);
  return Math.abs(age - expected) > rule.tolerance! ? `Edad esperada ${expected} a ${rule.asOf}` : null;
}
export function isOutlier(value: string, profile: Profile, options: OutlierOptions): boolean {
  if (options.method === 'none' || profile.type !== 'número' || (options.columns.length && !options.columns.includes(profile.key ?? profile.name))) return false;
  const d = profile.advanced, n = parseNumeric(value, profile.decimal);
  if (!d || n === null || d.count < (options.method === 'zscore' ? 3 : 4)) return false;
  if (options.method === 'zscore') return !!d.sd && Math.abs(n - d.mean!) / d.sd > options.factor;
  if (options.method === 'iqr') { const spread = d.q3! - d.q1!; return n < d.q1! - options.factor * spread || n > d.q3! + options.factor * spread; }
  return n < d.lowerPercentile! || n > d.upperPercentile!;
}
export interface Finding { code: string; column: string; label: string; severity: Severity; value: string; detail?: string }
export function findings(row: Row, profiles: Profile[], rules: Rules, headers: string[], duplicate = !!row.duplicateOf): Finding[] {
  const result: Finding[] = [];
  row.cells.forEach((value, i) => {
    const p = profiles[i], column = headers[i];
    if (isMissing(value)) result.push({ code: 'missing', column, label: 'Dato faltante', severity: 'advertencia', value });
    else if (invalidValue(value, p)) result.push({ code: 'invalid', column, label: p.type === 'CUIT/CUIL' ? 'CUIT/CUIL inválido' : `Valor incompatible con ${p.type}`, severity: p.type === 'CUIT/CUIL' && p.invalid / Math.max(1, p.present) >= .2 ? 'critico' : 'advertencia', value });
    if (value !== cleanText(value)) result.push({ code: 'dirty', column, label: 'Espacios o texto sin normalizar', severity: 'informativo', value });
    if (isOutlier(value, p, rules.outliers ?? DEFAULT_OUTLIERS)) result.push({ code: 'outlier', column, label: `Valor atípico (${rules.outliers!.method}) · solo bandera`, severity: 'advertencia', value });
  });
  if (duplicate) result.push({ code: 'duplicate', column: '(fila)', label: 'Fila duplicada exacta', severity: 'advertencia', value: '', detail: row.duplicateOf ? `Primera aparición: fila ${row.duplicateOf}` : undefined });
  for (const rule of rules.custom ?? []) {
    const failure = ruleFailure(rule, row.cells, profiles, headers);
    if (failure) result.push({ code: `rule:${rule.id}`, column: rule.column, label: rule.label, severity: rule.severity, value: row.cells[columnIndex(headers, rule.column)], detail: failure });
  }
  return result;
}
export class QualityCounter {
  private issues = new Map<string, Issue>();
  summary: QualitySummary = { rows: 0, errors: 0, rowsWithErrors: 0, severity: {critico: 0, advertencia: 0, informativo: 0}, issues: [] };
  add(row: Row, findings: Finding[]): void {
    this.summary.rows++;
    if (findings.some(f => f.severity !== 'informativo')) this.summary.rowsWithErrors++;
    for (const finding of findings) {
      this.summary.severity[finding.severity]++;
      if (finding.severity !== 'informativo') this.summary.errors++;
      const key = JSON.stringify([finding.code, finding.column]);
      let issue = this.issues.get(key);
      if (!issue) { issue = {code: finding.code, column: finding.column, label: finding.label, severity: finding.severity, count: 0, examples: []}; this.issues.set(key, issue); }
      issue.count++;
      if (issue.examples.length < 3) issue.examples.push({row: row.n, value: finding.value.slice(0, 100), detail: finding.detail?.slice(0, 200)});
    }
  }
  finish(): QualitySummary {
    for (const issue of this.issues.values()) {
      if (issue.code !== 'invalid' || issue.label !== 'CUIT/CUIL inválido') continue;
      const missing = this.issues.get(JSON.stringify(['missing', issue.column]))?.count ?? 0;
      const severity = issue.count / Math.max(1, this.summary.rows - missing) >= .2 ? 'critico' : 'advertencia';
      this.summary.severity[issue.severity] -= issue.count;
      issue.severity = severity; this.summary.severity[severity] += issue.count;
    }
    this.summary.issues = [...this.issues.values()].sort((a, b) => severities.indexOf(a.severity) - severities.indexOf(b.severity) || b.count - a.count);
    return this.summary;
  }
}
