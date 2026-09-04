import { rowCountOf, type ParsedCSV } from '../../csvParser';
import type { PyodideOlsInput } from './pythonOlsRunner';

export type ProNumericPayloadResult =
  | { ok: true; value: NonNullable<PyodideOlsInput['numericData']> }
  | { ok: false; error: string };

function blank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/**
 * Convierte sólo las columnas del modelo a buffers transferibles. En el camino
 * columnar lee directamente los arrays del limpiador; en el camino por filas
 * evita reconstruir y volver a parsear un CSV dentro de Python.
 */
export function buildProNumericPayload(
  data: ParsedCSV,
  yName: string,
  xNames: string[],
  dropIncompleteRows: boolean
): ProNumericPayloadResult {
  const names = [yName, ...xNames];
  const rowCount = rowCountOf(data);
  const columns = new Map<string, Float64Array>();
  const valid = new Uint8Array(rowCount).fill(1);
  const invalidText = new Set<string>();
  const hasNumeric = new Set<string>();

  for (const name of names) {
    const stored = data.columns?.numeric.get(name);
    if (stored) {
      // Se guarda una vista al array existente: no se duplica cada columna
      // completa antes de armar los dos buffers transferibles finales.
      columns.set(name, stored.values);
      for (let row = 0; row < rowCount; row++) {
        const value = stored.values[row];
        if (!stored.mask[row]) {
          valid[row] = 0;
          continue;
        }
        hasNumeric.add(name);
        if (!Number.isFinite(value)) valid[row] = 0;
      }
      continue;
    }

    const output = new Float64Array(rowCount);
    for (let row = 0; row < rowCount; row++) {
      const raw = data.rows[row]?.[name];
      if (blank(raw)) {
        valid[row] = 0;
        continue;
      }
      let value: number;
      try {
        value = Number(raw);
      } catch {
        invalidText.add(name);
        valid[row] = 0;
        continue;
      }
      if (Number.isNaN(value)) {
        valid[row] = 0;
        invalidText.add(name);
        continue;
      }
      hasNumeric.add(name);
      if (!Number.isFinite(value)) {
        valid[row] = 0;
        continue;
      }
      output[row] = value;
    }
    columns.set(name, output);
  }

  if (invalidText.size > 0) {
    return {
      ok: false,
      error:
        'Hay valores con texto o formato no numérico en: ' +
        [...invalidText].map(name => `"${name}"`).join(', ') +
        '. Revisá separadores decimales, símbolos y celdas mezcladas con palabras.',
    };
  }
  for (const name of names) {
    if (!hasNumeric.has(name)) {
      const kind = name === yName ? 'Y' : 'X';
      return { ok: false, error: `La columna ${kind} "${name}" no contiene valores numéricos.` };
    }
  }

  let completeRows = 0;
  for (const keep of valid) completeRows += keep;
  const droppedRows = rowCount - completeRows;
  if (droppedRows > 0 && !dropIncompleteRows) {
    return {
      ok: false,
      error:
        `Hay ${droppedRows} fila(s) con celdas vacías o valores infinitos en las columnas ` +
        'del modelo. Completá esos datos, o tildá "Excluir las filas con datos faltantes ' +
        '(listwise)" para estimar sin esas filas.',
    };
  }

  const yValues = new Float64Array(completeRows);
  const xValues = new Float64Array(completeRows * xNames.length);
  const yColumn = columns.get(yName)!;
  let targetRow = 0;
  for (let sourceRow = 0; sourceRow < rowCount; sourceRow++) {
    if (!valid[sourceRow]) continue;
    yValues[targetRow] = yColumn[sourceRow];
    for (let column = 0; column < xNames.length; column++) {
      xValues[targetRow * xNames.length + column] = columns.get(xNames[column])![sourceRow];
    }
    targetRow++;
  }

  return {
    ok: true,
    value: { yValues, xValues, rows: completeRows, columns: xNames.length, droppedRows },
  };
}
