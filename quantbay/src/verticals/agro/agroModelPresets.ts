// ChartBay Agro — presets de modelos econométricos agropecuarios.
//
// Los presets NO corren regresiones: sólo sugieren qué modelo tiene sentido
// dadas las columnas detectadas. La estimación la hace el motor común de
// ChartBay (runOLS / runRegressionMode / Pro), exactamente igual que en
// Econometría.

import type {
  AgroColumnDetectionResult,
  AgroColumnRole,
  AgroModelPreset,
  AgroModelPresetSuggestion,
} from './agroTypes';
import { normalizeAgroHeader } from './agroColumnDetection';
import { AGRO_TREND_COLUMN, rainfallSquaredColumnName } from './agroDerivedColumns';

export const AGRO_MODEL_PRESETS: AgroModelPreset[] = [
  {
    id: 'agro-yield',
    type: 'yield',
    label: 'Modelo de rinde',
    objective: 'Explicar el rinde agrícola (kg/ha o qq/ha) con clima e insumos.',
    yRoles: ['yield'],
    xRoles: ['rainfall', 'temperature', 'fertilizer', 'price', 'season', 'province'],
    coreXRoles: ['rainfall', 'temperature', 'fertilizer'],
    suggestedForm: 'lin-lin',
    includeTrend: true,
  },
  {
    id: 'agro-yield-hidrico',
    type: 'yield',
    label: 'Modelo de rinde (óptimo hídrico)',
    objective:
      'Explicar el rinde con lluvia y lluvia al cuadrado, para estimar el nivel de agua que ' +
      'maximiza el rinde (relación cóncava: rinde sube con la lluvia hasta un punto y después cae).',
    yRoles: ['yield'],
    xRoles: ['rainfall', 'temperature', 'fertilizer'],
    coreXRoles: ['rainfall'],
    suggestedForm: 'lin-lin',
    includeRainfallSquared: true,
    includeTrend: true,
  },
  {
    id: 'agro-price',
    type: 'price',
    label: 'Modelo de precio',
    objective: 'Explicar el precio local agropecuario con referencias internacionales y tipo de cambio.',
    yRoles: ['price'],
    // 'price' como X = otra columna de precio (Chicago / internacional).
    xRoles: ['price', 'exchange_rate', 'season'],
    coreXRoles: ['price', 'exchange_rate'],
    suggestedForm: 'log-log',
  },
  {
    id: 'agro-margin',
    type: 'margin',
    label: 'Modelo de margen',
    objective: 'Explicar el margen agrícola con rinde, precio y estructura de costos.',
    yRoles: ['margin'],
    xRoles: ['yield', 'price', 'cost', 'freight', 'rent', 'fertilizer', 'seed'],
    coreXRoles: ['yield', 'price', 'cost', 'freight', 'rent', 'fertilizer', 'seed'],
    suggestedForm: 'lin-lin',
  },
  {
    id: 'agro-production',
    type: 'production',
    label: 'Modelo de producción',
    objective: 'Explicar la producción agrícola con superficie, rinde y clima.',
    yRoles: ['production'],
    xRoles: ['area_planted', 'area_harvested', 'yield', 'rainfall', 'temperature'],
    coreXRoles: ['area_planted', 'area_harvested', 'yield'],
    suggestedForm: 'lin-lin',
  },
];

export function getAgroPresetById(id: string): AgroModelPreset | undefined {
  return AGRO_MODEL_PRESETS.find(preset => preset.id === id);
}

// Tokens que marcan a una columna de precio como referencia internacional
// (candidata a X en el modelo de precio, no a Y).
const INTERNATIONAL_PRICE_TOKENS = new Set(['chicago', 'internacional', 'international', 'cbot']);

function isInternationalPriceColumn(header: string): boolean {
  return normalizeAgroHeader(header)
    .split('_')
    .some(token => INTERNATIONAL_PRICE_TOKENS.has(token));
}

// Elige la columna Y para un preset. Para el modelo de precio prefiere el
// precio local (no-Chicago); para el resto, la primera columna del primer
// rol Y con matches.
function pickYColumn(preset: AgroModelPreset, byRole: AgroColumnDetectionResult['byRole']): string | null {
  for (const role of preset.yRoles) {
    const candidates = byRole[role];
    if (!candidates || candidates.length === 0) continue;
    if (preset.type === 'price') {
      const local = candidates.find(header => !isInternationalPriceColumn(header));
      return local ?? candidates[0];
    }
    return candidates[0];
  }
  return null;
}

const ROLE_LABELS: Record<AgroColumnRole, string> = {
  crop: 'cultivo',
  season: 'campaña',
  province: 'provincia',
  region: 'región',
  yield: 'rinde',
  rainfall: 'lluvia',
  temperature: 'temperatura',
  price: 'precio',
  cost: 'costo',
  margin: 'margen',
  production: 'producción',
  area_planted: 'superficie sembrada',
  area_harvested: 'superficie cosechada',
  exchange_rate: 'tipo de cambio',
  freight: 'flete',
  rent: 'alquiler',
  fertilizer: 'fertilizante',
  seed: 'semilla',
  agrochemical: 'agroquímicos',
  unknown: 'sin rol',
};

export function agroRoleLabel(role: AgroColumnRole): string {
  return ROLE_LABELS[role];
}

// Sugiere presets aplicables a partir de la detección de columnas.
// Nunca lanza error: si falta información devuelve un array vacío.
// El score premia presets con más roles X cubiertos; se ordena descendente.
export function suggestAgroModelPresets(
  detection: AgroColumnDetectionResult
): AgroModelPresetSuggestion[] {
  const suggestions: AgroModelPresetSuggestion[] = [];

  for (const preset of AGRO_MODEL_PRESETS) {
    const yColumn = pickYColumn(preset, detection.byRole);
    if (yColumn === null) continue;

    const xColumns: string[] = [];
    const foundRoles: AgroColumnRole[] = [];
    const missingRoles: AgroColumnRole[] = [];
    for (const role of preset.xRoles) {
      const columns = (detection.byRole[role] ?? []).filter(header => header !== yColumn);
      if (columns.length > 0) {
        foundRoles.push(role);
        xColumns.push(...columns.filter(header => !xColumns.includes(header)));
      } else {
        missingRoles.push(role);
      }
    }

    if (xColumns.length === 0) continue;
    if (!preset.coreXRoles.some(role => foundRoles.includes(role))) continue;

    // Columnas derivadas agronómicas (lluvia al cuadrado, tendencia): se
    // suman como X candidatas por nombre, no por rol — las genera el vertical
    // recién al cargar el dataset en Econometría (ver agroDerivedColumns.ts
    // y el bridge en agroView.ts), así que acá todavía no existen en el CSV.
    const derivedNotes: string[] = [];
    if (preset.includeRainfallSquared) {
      for (const rainfallHeader of detection.byRole.rainfall ?? []) {
        if (rainfallHeader === yColumn) continue;
        const squaredHeader = rainfallSquaredColumnName(rainfallHeader);
        if (!xColumns.includes(squaredHeader)) {
          xColumns.push(squaredHeader);
          derivedNotes.push(`"${squaredHeader}" (lluvia al cuadrado, para estimar el óptimo hídrico)`);
        }
      }
    }
    if (preset.includeTrend && (detection.byRole.season ?? []).length > 0 && !xColumns.includes(AGRO_TREND_COLUMN)) {
      xColumns.push(AGRO_TREND_COLUMN);
      derivedNotes.push(
        `"${AGRO_TREND_COLUMN}" (tendencia tecnológica por campaña: sin ella el modelo le atribuye al clima ` +
        `la mejora genética y de manejo)`
      );
    }

    const score = 0.4 + 0.6 * (foundRoles.length / preset.xRoles.length);
    const reason =
      `Se detectó "${yColumn}" como ${ROLE_LABELS[preset.yRoles[0]]} (variable objetivo) y ` +
      `${xColumns.length} regresor(es) candidato(s): ${xColumns.map(c => `"${c}"`).join(', ')} ` +
      `(${foundRoles.map(r => ROLE_LABELS[r]).join(', ')})` +
      (derivedNotes.length > 0 ? `. Se suman columnas derivadas: ${derivedNotes.join('; ')}` : '') +
      '.';

    suggestions.push({
      preset,
      score: Number(score.toFixed(4)),
      yColumn,
      xColumns,
      reason,
      missingRoles,
    });
  }

  // Orden descendente por score; empates conservan el orden de declaración
  // de los presets (sort es estable en JS moderno).
  return suggestions.sort((a, b) => b.score - a.score);
}
