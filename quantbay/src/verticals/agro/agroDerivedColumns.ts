// ChartBay Agro — columnas derivadas agronómicas para el motor econométrico.
//
// El motor común (regression.ts / functionalForms.ts) NO se toca: sigue
// soportando únicamente lin-lin, log-lin, lin-log y log-log. Los términos
// agronómicos que necesitan una forma funcional distinta (lluvia al cuadrado
// para captar un óptimo hídrico, una tendencia tecnológica lineal en el
// tiempo) entran como columnas derivadas que este módulo agrega al dataset
// ANTES de cargarlo en Econometría: para el motor son regresores comunes.
//
// Funciones puras: no tocan el DOM ni dependen de agroView.

import type { AgroColumnDetectionResult, AgroExampleDataset } from './agroTypes';

export const AGRO_TREND_COLUMN = 'tendencia';
const RAINFALL_SQUARED_SUFFIX = '_cuadrado';

// Nombre de la columna derivada de lluvia al cuadrado para un header dado.
export function rainfallSquaredColumnName(rainfallHeader: string): string {
  return `${rainfallHeader}${RAINFALL_SQUARED_SUFFIX}`;
}

// Si `name` es una columna de lluvia al cuadrado (por convención de nombre),
// devuelve el header de lluvia original; si no, null. Permite reconocer el
// término cuadrático en la interpretación sin depender de roles agro.
export function rainfallHeaderFromSquaredColumn(name: string): string | null {
  return name.endsWith(RAINFALL_SQUARED_SUFFIX)
    ? name.slice(0, -RAINFALL_SQUARED_SUFFIX.length)
    : null;
}

// Extrae el año de inicio de una etiqueta de campaña: "2023/24" -> 2023,
// "2005/2006" -> 2005, "2023" -> 2023. Devuelve null si no hay dígitos al
// inicio (formato no reconocido) — el llamador decide cómo tratar esas filas.
export function parseSeasonStartYear(label: string): number | null {
  const match = String(label).trim().match(/^(\d+)/);
  if (!match) return null;
  return Number(match[1]);
}

// Codifica etiquetas de campaña (con repeticiones) como tendencia
// cronológica 0, 1, 2, ... — mismo valor para la misma etiqueta, en orden de
// año de inicio ascendente. Las etiquetas no parseables quedan con valor
// null (el llamador decide cómo tratarlas: normalmente, celda vacía).
export function buildSeasonTrendMap(seasonLabels: string[]): Map<string, number | null> {
  const distinct = Array.from(new Set(seasonLabels));
  const parseable = distinct
    .map(label => ({ label, year: parseSeasonStartYear(label) }))
    .filter((entry): entry is { label: string; year: number } => entry.year !== null)
    .sort((a, b) => a.year - b.year);

  const map = new Map<string, number | null>();
  for (const label of distinct) map.set(label, null);
  parseable.forEach((entry, index) => map.set(entry.label, index));
  return map;
}

export interface AgroDerivedColumnsResult {
  columns: string[];
  rows: Array<Record<string, string | number>>;
  addedColumns: string[];
  warnings: string[];
}

// Agrega al dataset detectado las columnas derivadas agronómicas aplicables,
// sin mutar el original: `<header>_cuadrado` por cada columna con rol
// 'rainfall', y una columna 'tendencia' (0,1,2,... cronológico) si hay rol
// 'season'. Si no hay ninguno de esos roles, devuelve el dataset sin cambios.
export function addAgroDerivedColumns(
  dataset: Pick<AgroExampleDataset, 'columns' | 'rows'>,
  detection: AgroColumnDetectionResult
): AgroDerivedColumnsResult {
  const columns = [...dataset.columns];
  const addedColumns: string[] = [];
  const warnings: string[] = [];
  const rows = dataset.rows.map(row => ({ ...row }));

  for (const rainfallHeader of detection.byRole.rainfall ?? []) {
    // Si el header ya es una columna al cuadrado (p. ej. porque el CSV
    // original ya traía una, o porque se está reprocesando un dataset ya
    // enriquecido), no se vuelve a elevar al cuadrado.
    if (rainfallHeaderFromSquaredColumn(rainfallHeader)) continue;
    const squaredHeader = rainfallSquaredColumnName(rainfallHeader);
    if (columns.includes(squaredHeader)) continue;
    columns.push(squaredHeader);
    addedColumns.push(squaredHeader);
    for (const row of rows) {
      const value = Number(row[rainfallHeader]);
      row[squaredHeader] = Number.isFinite(value) ? value * value : '';
    }
  }

  const seasonHeader = (detection.byRole.season ?? [])[0];
  if (seasonHeader && !columns.includes(AGRO_TREND_COLUMN)) {
    const trendMap = buildSeasonTrendMap(rows.map(row => String(row[seasonHeader] ?? '')));
    const unparsed = Array.from(trendMap.entries()).filter(([, value]) => value === null);
    if (unparsed.length > 0) {
      warnings.push(
        `No se pudo interpretar la campaña de ${unparsed.length} valor(es) de "${seasonHeader}" ` +
        `(ej.: "${unparsed[0][0]}"); la tendencia queda vacía para esas filas.`
      );
    }
    columns.push(AGRO_TREND_COLUMN);
    addedColumns.push(AGRO_TREND_COLUMN);
    for (const row of rows) {
      const trend = trendMap.get(String(row[seasonHeader] ?? ''));
      row[AGRO_TREND_COLUMN] = trend === null || trend === undefined ? '' : trend;
    }
  }

  return { columns, rows, addedColumns, warnings };
}
