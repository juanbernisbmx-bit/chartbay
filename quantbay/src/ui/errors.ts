import type { ParsedCSV } from '../csvParser';
import { AnalysisValidationError } from '../services/analysisService';

export const CSV_LIMITS = { maxRows: 5000, maxCols: 50, maxXVars: 20 };

export function checkCSVLimits(data: ParsedCSV, xNames: string[]): string | null {
  if (data.rows.length > CSV_LIMITS.maxRows)
    return `El CSV tiene ${data.rows.length} filas. El máximo soportado es ${CSV_LIMITS.maxRows}. Reducí el dataset antes de calcular.`;
  if (data.headers.length > CSV_LIMITS.maxCols)
    return `El CSV tiene ${data.headers.length} columnas. El máximo soportado es ${CSV_LIMITS.maxCols}.`;
  if (xNames.length > CSV_LIMITS.maxXVars)
    return `Seleccionaste ${xNames.length} variables X. El máximo es ${CSV_LIMITS.maxXVars}. Reducí la selección.`;
  return null;
}

export function formatRegressionError(err: unknown): string {
  if (err instanceof AnalysisValidationError) {
    const lines = err.issues.map(issue => {
      const cols = issue.columns.map(col => `"${col}"`).join(', ');
      switch (issue.type) {
        case 'missing_values':
          return `Hay celdas vacias en ${cols}. Completa esos datos o filtra esas filas antes de calcular.`;
        case 'invalid_numeric':
          return `Hay valores no numericos en ${cols}. Revisa texto, simbolos, separadores decimales o celdas mezcladas con palabras.`;
        case 'constant_column':
          return `${cols} no cambia entre filas. Una variable constante no ayuda a explicar Y; usa otra variable o agrega datos con variacion.`;
        case 'duplicate_column':
          return `${cols} contienen la misma informacion fila por fila. Deja solo una de esas columnas.`;
        case 'collinearity':
          return `${cols} estan demasiado relacionadas entre si. El modelo no puede separar sus efectos; quita una variable o transforma los datos.`;
        default:
          return issue.message;
      }
    });
    return [
      'No se pudo calcular la regresión.',
      ...lines.map(line => `- ${line}`),
      'ChartBay no cambió ni eliminó datos automáticamente.',
    ].join('\n');
  }

  const message = (err as Error).message ?? String(err);
  if (/Observaciones insuficientes/i.test(message)) {
    return `${message}\nSugerencia: usá menos variables X o cargá un dataset con más filas numéricas completas.`;
  }
  if (/singular|colineal|rango|rank/i.test(message)) {
    return `${message}\nSugerencia: quita una variable repetida o una variable que sea combinacion de otras.`;
  }
  return message;
}
