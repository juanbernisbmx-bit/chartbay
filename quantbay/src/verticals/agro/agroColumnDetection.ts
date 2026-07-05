// ChartBay Agro — detección de roles agro en headers de CSV.
//
// Función pura: no muta el input, no toca el DOM, no corre modelos.
// Reconoce aliases en español e inglés, tolera mayúsculas, acentos,
// espacios, guiones y separadores tipo "kg/ha", "usd/tn".

import type {
  AgroColumnDetectionResult,
  AgroColumnRole,
  AgroDetectedColumn,
} from './agroTypes';

// Normaliza un header: minúsculas, sin acentos, trim, separadores → "_".
export function normalizeAgroHeader(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')  // saca acentos (a con tilde -> a, enie -> n)
    .toLowerCase()
    .trim()
    .replace(/[\s/\-.]+/g, '_')        // espacios, "/", "-", "." → "_"
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Aliases por rol. Se escriben en su forma natural (con acentos, "/") y se
// normalizan una sola vez al cargar el módulo, con la misma normalización
// que se aplica a los headers.
const RAW_ALIASES: Partial<Record<AgroColumnRole, string[]>> = {
  yield: [
    'rinde', 'rendimiento', 'yield', 'kg_ha', 'kg/ha', 'kg ha',
    'qq_ha', 'qq/ha', 'qq ha', 'quintales', 'quintales_ha',
  ],
  rainfall: [
    'lluvia', 'precipitacion', 'precipitación', 'precipitations',
    'precipitation', 'rain', 'rainfall', 'mm', 'lluvia_mm', 'precipitacion_mm',
  ],
  temperature: [
    'temperatura', 'temp', 'temperature', 'temperatura_media', 'temp_media',
    'mean_temperature', 'temperatura_max', 'temperatura_min',
  ],
  price: [
    'precio', 'price', 'precio_usd', 'precio_usd_tn', 'usd_tn', 'usd/tn',
    'usd ton', 'chicago', 'rosario', 'precio_local', 'precio_internacional',
  ],
  cost: [
    'costo', 'cost', 'costos', 'total_cost', 'costo_total', 'insumos', 'input_cost',
  ],
  margin: [
    'margen', 'margen_bruto', 'margen_neto', 'gross_margin', 'net_margin', 'margin',
  ],
  season: [
    'campaña', 'campania', 'campaign', 'season', 'ciclo', 'campana',
    'year', 'anio', 'año', 'mes', 'month', 'fecha', 'date',
  ],
  province: [
    'provincia', 'province', 'departamento', 'localidad', 'location',
  ],
  region: [
    'region', 'región', 'zona',
  ],
  production: [
    'produccion', 'producción', 'production', 'toneladas', 'tons', 'tn',
    'volumen', 'volume',
  ],
  area_planted: [
    'superficie', 'area', 'hectareas', 'hectáreas', 'ha',
    'superficie_sembrada', 'area_planted', 'sembrada',
  ],
  area_harvested: [
    'superficie_cosechada', 'area_harvested', 'cosechada',
  ],
  exchange_rate: [
    'dolar', 'dólar', 'tipo_cambio', 'exchange_rate', 'fx', 'usd_ars', 'tc',
  ],
  freight: [
    'flete', 'freight', 'transport', 'transporte', 'logistica', 'logística',
  ],
  rent: [
    'alquiler', 'rent', 'arrendamiento', 'lease',
  ],
  fertilizer: [
    'fertilizante', 'fertilizer', 'fertilizacion', 'fertilización', 'urea', 'fosfato',
  ],
  seed: [
    'semilla', 'seed', 'seeds', 'siembra',
  ],
  agrochemical: [
    'agroquimico', 'agroquímico', 'agroquimicos', 'agroquímicos',
    'herbicida', 'herbicide', 'fungicida', 'fungicide',
    'insecticida', 'insecticide', 'fitosanitario',
  ],
  crop: [
    'cultivo', 'cultivos', 'crop',
  ],
};

interface AliasEntry {
  role: AgroColumnRole;
  alias: string;      // alias normalizado
  tokens: string[];   // alias partido por "_"
}

const ALIAS_ENTRIES: AliasEntry[] = (
  Object.entries(RAW_ALIASES) as Array<[AgroColumnRole, string[]]>
).flatMap(([role, aliases]) => {
  const seen = new Set<string>();
  return aliases.reduce<AliasEntry[]>((acc, raw) => {
    const alias = normalizeAgroHeader(raw);
    if (alias && !seen.has(alias)) {
      seen.add(alias);
      acc.push({ role, alias, tokens: alias.split('_') });
    }
    return acc;
  }, []);
});

interface AliasMatch extends AliasEntry {
  exact: boolean;     // el header entero coincide con el alias
  position: number;   // índice del token donde empieza el match (0 = al inicio)
}

// Devuelve el índice del primer token donde `aliasTokens` aparece como
// subsecuencia contigua de `tokens`, o -1 si no aparece.
function findTokenSubsequence(tokens: string[], aliasTokens: string[]): number {
  outer: for (let start = 0; start + aliasTokens.length <= tokens.length; start++) {
    for (let i = 0; i < aliasTokens.length; i++) {
      if (tokens[start + i] !== aliasTokens[i]) continue outer;
    }
    return start;
  }
  return -1;
}

// Reglas de prioridad entre matches (de mayor a menor):
//   1. match exacto del header completo,
//   2. match que empieza más al principio del header ("flete_usd_tn" → flete,
//      no usd_tn: en los nombres compuestos el sustantivo principal va primero),
//   3. alias más largo ("superficie_sembrada" gana sobre "superficie"),
//   4. orden de declaración (estable).
function compareMatches(a: AliasMatch, b: AliasMatch): number {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (a.position !== b.position) return a.position - b.position;
  return b.alias.length - a.alias.length;
}

function detectOne(header: string): { column: AgroDetectedColumn; ambiguity: string | null } {
  const normalized = normalizeAgroHeader(header);
  if (!normalized) {
    return {
      column: { original: header, normalized, role: 'unknown', confidence: 0, matchedAlias: null },
      ambiguity: null,
    };
  }

  const tokens = normalized.split('_');
  const matches: AliasMatch[] = [];
  for (const entry of ALIAS_ENTRIES) {
    if (normalized === entry.alias) {
      matches.push({ ...entry, exact: true, position: 0 });
      continue;
    }
    const position = findTokenSubsequence(tokens, entry.tokens);
    if (position >= 0) matches.push({ ...entry, exact: false, position });
  }

  if (matches.length === 0) {
    return {
      column: { original: header, normalized, role: 'unknown', confidence: 0, matchedAlias: null },
      ambiguity: null,
    };
  }

  matches.sort(compareMatches);
  const best = matches[0];
  const runnerUp = matches[1];

  // Empate real entre roles distintos → se elige el primero declarado y se avisa.
  const ambiguity =
    runnerUp &&
    runnerUp.role !== best.role &&
    compareMatches(best, runnerUp) === 0
      ? `La columna "${header}" es ambigua entre los roles "${best.role}" y "${runnerUp.role}"; se asignó "${best.role}".`
      : null;

  const confidence = best.exact ? 1 : best.alias.length >= 4 ? 0.8 : 0.6;

  return {
    column: {
      original: header,
      normalized,
      role: best.role,
      confidence,
      matchedAlias: best.alias,
    },
    ambiguity,
  };
}

// Detecta el rol agro de cada header. No muta `headers`.
export function detectAgroColumns(headers: string[]): AgroColumnDetectionResult {
  const warnings: string[] = [];
  const columns: AgroDetectedColumn[] = [];
  const byRole: Partial<Record<AgroColumnRole, string[]>> = {};
  const seenNormalized = new Map<string, string>();

  for (const header of headers) {
    const { column, ambiguity } = detectOne(header);
    columns.push(column);
    if (ambiguity) warnings.push(ambiguity);

    if (column.normalized) {
      const previous = seenNormalized.get(column.normalized);
      if (previous !== undefined) {
        warnings.push(
          `Columnas duplicadas: "${previous}" y "${header}" normalizan al mismo nombre ("${column.normalized}").`
        );
      } else {
        seenNormalized.set(column.normalized, header);
      }
    }

    if (column.role !== 'unknown') {
      (byRole[column.role] ??= []).push(column.original);
    }
  }

  return { columns, byRole, warnings };
}
