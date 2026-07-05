// ChartBay Agro — reglas n/k para recomendar modelos seguros.
//
// Heurística liviana, previa a estimar: avisa si la cantidad de observaciones
// (n) alcanza cómodamente para la cantidad de regresores elegidos (k), antes
// de que el usuario gaste tiempo corriendo el modelo. NO reemplaza los
// chequeos del motor (rango de la matriz de diseño, colinealidad perfecta,
// etc. en regression.ts): esos siguen siendo la única fuente de verdad ante
// un problema numérico real; esto es sólo una guía pedagógica previa.

import type { AgroModelCapacityAssessment, AgroModelCapacityLevel } from './agroTypes';

// Por debajo de este piso de observaciones, agregar variables categóricas
// (que se expanden en dummies) es especialmente riesgoso.
const CATEGORICAL_RISK_ROW_THRESHOLD = 100;

export function assessAgroModelCapacity(
  rowCount: number,
  selectedXCount: number,
  categoricalXCount = 0
): AgroModelCapacityAssessment {
  const maxRecommendedX = Math.max(0, Math.floor(rowCount / 5));
  const messages: string[] = [];

  if (rowCount <= selectedXCount + 2) {
    messages.push(
      `Con ${rowCount} observación(es) y ${selectedXCount} variable(s) X, el modelo está en el límite o ` +
      `por debajo del mínimo matemático para estimar (se necesita n > k + 1). Reducí las X seleccionadas ` +
      `o conseguí más observaciones antes de correr el modelo.`
    );
    return { level: 'unsafe', maxRecommendedX, messages };
  }

  let level: AgroModelCapacityLevel = 'safe';

  if (rowCount < selectedXCount * 5) {
    level = 'warning';
    messages.push(
      `Con ${rowCount} observación(es) para ${selectedXCount} variable(s) X hay menos de 5 observaciones ` +
      `por regresor (regla práctica habitual). Los coeficientes pueden ser inestables; considerá reducir ` +
      `las X o sumar más datos.`
    );
  }

  if (categoricalXCount > 0 && rowCount < CATEGORICAL_RISK_ROW_THRESHOLD) {
    if (level === 'safe') level = 'warning';
    messages.push(
      `Hay ${categoricalXCount} variable(s) categórica(s) entre las X seleccionadas. Cada categoría agrega ` +
      `una dummy al modelo: con pocas observaciones (${rowCount}) conviene agrupar categorías poco ` +
      `frecuentes o usar menos controles categóricos.`
    );
  }

  if (messages.length === 0) {
    messages.push(
      `Margen cómodo: ${rowCount} observación(es) para ${selectedXCount} variable(s) X (recomendado hasta ` +
      `${maxRecommendedX} X con este n).`
    );
  }

  return { level, maxRecommendedX, messages };
}
