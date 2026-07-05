// ChartBay Agro — datasets sintéticos de demostración.
//
// IMPORTANTE: todos los datos son SINTÉTICOS. Los valores son plausibles para
// el agro argentino (rindes, precios FOB/Chicago, costos por hectárea) pero
// fueron generados a mano para la demo: no provienen de ninguna fuente real
// y no deben usarse para decisiones productivas o comerciales.
//
// Coherencia interna garantizada (y testeada):
//   - soja:  produccion_tn = rinde_kg_ha × superficie_sembrada_ha / 1000
//   - maíz:  margen_bruto_usd_ha = rinde_tn×precio − costos/ha − flete×rinde_tn

import type { AgroCrop, AgroExampleDataset, AgroLargeSyntheticDatasetOptions } from './agroTypes';

export const SOJA_RINDE_DEMO: AgroExampleDataset = {
  id: 'soja_rinde_demo',
  name: 'Soja — rinde por campaña y provincia (sintético)',
  description:
    'Rindes de soja por provincia en 4 campañas, con lluvia acumulada, temperatura media, ' +
    'precio y superficie. Datos sintéticos para explorar el modelo de rinde.',
  crop: 'soja',
  synthetic: true,
  columns: [
    'campaña', 'provincia', 'rinde_kg_ha', 'lluvia_mm', 'temperatura_media',
    'precio_usd_tn', 'superficie_sembrada_ha', 'produccion_tn',
  ],
  rows: [
    { 'campaña': '2020/21', provincia: 'Buenos Aires', rinde_kg_ha: 3100, lluvia_mm: 820, temperatura_media: 16.8, precio_usd_tn: 330, superficie_sembrada_ha: 1850000, produccion_tn: 5735000 },
    { 'campaña': '2020/21', provincia: 'Córdoba', rinde_kg_ha: 2850, lluvia_mm: 700, temperatura_media: 17.5, precio_usd_tn: 330, superficie_sembrada_ha: 1600000, produccion_tn: 4560000 },
    { 'campaña': '2020/21', provincia: 'Santa Fe', rinde_kg_ha: 2950, lluvia_mm: 780, temperatura_media: 18.2, precio_usd_tn: 330, superficie_sembrada_ha: 1050000, produccion_tn: 3097500 },
    { 'campaña': '2020/21', provincia: 'Entre Ríos', rinde_kg_ha: 3050, lluvia_mm: 900, temperatura_media: 18.0, precio_usd_tn: 330, superficie_sembrada_ha: 620000, produccion_tn: 1891000 },
    { 'campaña': '2021/22', provincia: 'Buenos Aires', rinde_kg_ha: 2500, lluvia_mm: 560, temperatura_media: 17.6, precio_usd_tn: 405, superficie_sembrada_ha: 1830000, produccion_tn: 4575000 },
    { 'campaña': '2021/22', provincia: 'Córdoba', rinde_kg_ha: 2250, lluvia_mm: 480, temperatura_media: 18.1, precio_usd_tn: 405, superficie_sembrada_ha: 1580000, produccion_tn: 3555000 },
    { 'campaña': '2021/22', provincia: 'Santa Fe', rinde_kg_ha: 2300, lluvia_mm: 510, temperatura_media: 18.9, precio_usd_tn: 405, superficie_sembrada_ha: 1020000, produccion_tn: 2346000 },
    { 'campaña': '2021/22', provincia: 'Entre Ríos', rinde_kg_ha: 2400, lluvia_mm: 590, temperatura_media: 18.6, precio_usd_tn: 405, superficie_sembrada_ha: 600000, produccion_tn: 1440000 },
    { 'campaña': '2022/23', provincia: 'Buenos Aires', rinde_kg_ha: 1950, lluvia_mm: 430, temperatura_media: 18.4, precio_usd_tn: 480, superficie_sembrada_ha: 1800000, produccion_tn: 3510000 },
    { 'campaña': '2022/23', provincia: 'Córdoba', rinde_kg_ha: 1700, lluvia_mm: 380, temperatura_media: 18.9, precio_usd_tn: 480, superficie_sembrada_ha: 1550000, produccion_tn: 2635000 },
    { 'campaña': '2022/23', provincia: 'Santa Fe', rinde_kg_ha: 1650, lluvia_mm: 400, temperatura_media: 19.5, precio_usd_tn: 480, superficie_sembrada_ha: 1000000, produccion_tn: 1650000 },
    { 'campaña': '2022/23', provincia: 'Entre Ríos', rinde_kg_ha: 1800, lluvia_mm: 460, temperatura_media: 19.2, precio_usd_tn: 480, superficie_sembrada_ha: 590000, produccion_tn: 1062000 },
    { 'campaña': '2023/24', provincia: 'Buenos Aires', rinde_kg_ha: 3450, lluvia_mm: 950, temperatura_media: 16.9, precio_usd_tn: 305, superficie_sembrada_ha: 1870000, produccion_tn: 6451500 },
    { 'campaña': '2023/24', provincia: 'Córdoba', rinde_kg_ha: 3300, lluvia_mm: 860, temperatura_media: 17.3, precio_usd_tn: 305, superficie_sembrada_ha: 1620000, produccion_tn: 5346000 },
    { 'campaña': '2023/24', provincia: 'Santa Fe', rinde_kg_ha: 3350, lluvia_mm: 910, temperatura_media: 17.8, precio_usd_tn: 305, superficie_sembrada_ha: 1060000, produccion_tn: 3551000 },
    { 'campaña': '2023/24', provincia: 'Entre Ríos', rinde_kg_ha: 3400, lluvia_mm: 1000, temperatura_media: 17.6, precio_usd_tn: 305, superficie_sembrada_ha: 640000, produccion_tn: 2176000 },
  ],
  suggestedPresetId: 'agro-yield',
};

export const MAIZ_MARGEN_DEMO: AgroExampleDataset = {
  id: 'maiz_margen_demo',
  name: 'Maíz — margen bruto por hectárea (sintético)',
  description:
    'Márgenes brutos de maíz con rinde en qq/ha, precio, costos de insumos, flete y alquiler. ' +
    'Datos sintéticos para explorar el modelo de margen y el simulador.',
  crop: 'maiz',
  synthetic: true,
  columns: [
    'campaña', 'provincia', 'rinde_qq_ha', 'precio_usd_tn', 'costo_semilla_usd_ha',
    'costo_fertilizante_usd_ha', 'costo_agroquimicos_usd_ha', 'flete_usd_tn',
    'alquiler_usd_ha', 'margen_bruto_usd_ha',
  ],
  rows: [
    { 'campaña': '2021/22', provincia: 'Córdoba', rinde_qq_ha: 85, precio_usd_tn: 175, costo_semilla_usd_ha: 190, costo_fertilizante_usd_ha: 260, costo_agroquimicos_usd_ha: 110, flete_usd_tn: 28, alquiler_usd_ha: 250, margen_bruto_usd_ha: 439.5 },
    { 'campaña': '2021/22', provincia: 'Buenos Aires', rinde_qq_ha: 92, precio_usd_tn: 168, costo_semilla_usd_ha: 195, costo_fertilizante_usd_ha: 270, costo_agroquimicos_usd_ha: 115, flete_usd_tn: 27, alquiler_usd_ha: 260, margen_bruto_usd_ha: 457.2 },
    { 'campaña': '2021/22', provincia: 'Santa Fe', rinde_qq_ha: 78, precio_usd_tn: 182, costo_semilla_usd_ha: 185, costo_fertilizante_usd_ha: 250, costo_agroquimicos_usd_ha: 105, flete_usd_tn: 30, alquiler_usd_ha: 240, margen_bruto_usd_ha: 405.6 },
    { 'campaña': '2021/22', provincia: 'La Pampa', rinde_qq_ha: 101, precio_usd_tn: 160, costo_semilla_usd_ha: 200, costo_fertilizante_usd_ha: 285, costo_agroquimicos_usd_ha: 120, flete_usd_tn: 26, alquiler_usd_ha: 275, margen_bruto_usd_ha: 473.4 },
    { 'campaña': '2022/23', provincia: 'Córdoba', rinde_qq_ha: 69, precio_usd_tn: 195, costo_semilla_usd_ha: 180, costo_fertilizante_usd_ha: 235, costo_agroquimicos_usd_ha: 100, flete_usd_tn: 32, alquiler_usd_ha: 220, margen_bruto_usd_ha: 389.7 },
    { 'campaña': '2022/23', provincia: 'Buenos Aires', rinde_qq_ha: 95, precio_usd_tn: 165, costo_semilla_usd_ha: 198, costo_fertilizante_usd_ha: 275, costo_agroquimicos_usd_ha: 118, flete_usd_tn: 27, alquiler_usd_ha: 265, margen_bruto_usd_ha: 455 },
    { 'campaña': '2022/23', provincia: 'Santa Fe', rinde_qq_ha: 88, precio_usd_tn: 172, costo_semilla_usd_ha: 192, costo_fertilizante_usd_ha: 262, costo_agroquimicos_usd_ha: 112, flete_usd_tn: 29, alquiler_usd_ha: 255, margen_bruto_usd_ha: 437.4 },
    { 'campaña': '2022/23', provincia: 'La Pampa', rinde_qq_ha: 74, precio_usd_tn: 188, costo_semilla_usd_ha: 183, costo_fertilizante_usd_ha: 245, costo_agroquimicos_usd_ha: 103, flete_usd_tn: 31, alquiler_usd_ha: 230, margen_bruto_usd_ha: 400.8 },
    { 'campaña': '2023/24', provincia: 'Córdoba', rinde_qq_ha: 106, precio_usd_tn: 158, costo_semilla_usd_ha: 205, costo_fertilizante_usd_ha: 290, costo_agroquimicos_usd_ha: 124, flete_usd_tn: 25, alquiler_usd_ha: 280, margen_bruto_usd_ha: 510.8 },
    { 'campaña': '2023/24', provincia: 'Buenos Aires', rinde_qq_ha: 81, precio_usd_tn: 178, costo_semilla_usd_ha: 188, costo_fertilizante_usd_ha: 255, costo_agroquimicos_usd_ha: 108, flete_usd_tn: 30, alquiler_usd_ha: 245, margen_bruto_usd_ha: 402.8 },
    { 'campaña': '2023/24', provincia: 'Santa Fe', rinde_qq_ha: 98, precio_usd_tn: 162, costo_semilla_usd_ha: 199, costo_fertilizante_usd_ha: 280, costo_agroquimicos_usd_ha: 119, flete_usd_tn: 26, alquiler_usd_ha: 270, margen_bruto_usd_ha: 464.8 },
    { 'campaña': '2023/24', provincia: 'La Pampa', rinde_qq_ha: 90, precio_usd_tn: 170, costo_semilla_usd_ha: 194, costo_fertilizante_usd_ha: 265, costo_agroquimicos_usd_ha: 114, flete_usd_tn: 28, alquiler_usd_ha: 258, margen_bruto_usd_ha: 447 },
  ],
  suggestedPresetId: 'agro-margin',
};

export const TRIGO_PRECIO_DEMO: AgroExampleDataset = {
  id: 'trigo_precio_demo',
  name: 'Trigo — precio local vs Chicago (sintético)',
  description:
    'Serie mensual de precio local del trigo junto a la referencia Chicago, tipo de cambio y ' +
    'volumen exportado. Datos sintéticos para explorar el modelo de precio (transmisión internacional).',
  crop: 'trigo',
  synthetic: true,
  columns: [
    'mes', 'precio_local_usd_tn', 'precio_chicago_usd_tn', 'tipo_cambio',
    'volumen_exportado_tn', 'campaña',
  ],
  rows: [
    { mes: '2024-01', precio_local_usd_tn: 192, precio_chicago_usd_tn: 228, tipo_cambio: 818, volumen_exportado_tn: 310000, 'campaña': '2023/24' },
    { mes: '2024-02', precio_local_usd_tn: 189, precio_chicago_usd_tn: 224, tipo_cambio: 836, volumen_exportado_tn: 280000, 'campaña': '2023/24' },
    { mes: '2024-03', precio_local_usd_tn: 184, precio_chicago_usd_tn: 219, tipo_cambio: 853, volumen_exportado_tn: 340000, 'campaña': '2023/24' },
    { mes: '2024-04', precio_local_usd_tn: 179, precio_chicago_usd_tn: 214, tipo_cambio: 871, volumen_exportado_tn: 420000, 'campaña': '2023/24' },
    { mes: '2024-05', precio_local_usd_tn: 190, precio_chicago_usd_tn: 226, tipo_cambio: 887, volumen_exportado_tn: 510000, 'campaña': '2023/24' },
    { mes: '2024-06', precio_local_usd_tn: 197, precio_chicago_usd_tn: 233, tipo_cambio: 904, volumen_exportado_tn: 470000, 'campaña': '2023/24' },
    { mes: '2024-07', precio_local_usd_tn: 186, precio_chicago_usd_tn: 221, tipo_cambio: 921, volumen_exportado_tn: 390000, 'campaña': '2023/24' },
    { mes: '2024-08', precio_local_usd_tn: 181, precio_chicago_usd_tn: 216, tipo_cambio: 938, volumen_exportado_tn: 360000, 'campaña': '2023/24' },
    { mes: '2024-09', precio_local_usd_tn: 177, precio_chicago_usd_tn: 212, tipo_cambio: 954, volumen_exportado_tn: 330000, 'campaña': '2023/24' },
    { mes: '2024-10', precio_local_usd_tn: 183, precio_chicago_usd_tn: 218, tipo_cambio: 972, volumen_exportado_tn: 300000, 'campaña': '2023/24' },
    { mes: '2024-11', precio_local_usd_tn: 189, precio_chicago_usd_tn: 224, tipo_cambio: 989, volumen_exportado_tn: 280000, 'campaña': '2023/24' },
    { mes: '2024-12', precio_local_usd_tn: 195, precio_chicago_usd_tn: 230, tipo_cambio: 1010, volumen_exportado_tn: 620000, 'campaña': '2024/25' },
    { mes: '2025-01', precio_local_usd_tn: 201, precio_chicago_usd_tn: 236, tipo_cambio: 1032, volumen_exportado_tn: 780000, 'campaña': '2024/25' },
    { mes: '2025-02', precio_local_usd_tn: 206, precio_chicago_usd_tn: 241, tipo_cambio: 1055, volumen_exportado_tn: 850000, 'campaña': '2024/25' },
    { mes: '2025-03', precio_local_usd_tn: 199, precio_chicago_usd_tn: 234, tipo_cambio: 1078, volumen_exportado_tn: 730000, 'campaña': '2024/25' },
    { mes: '2025-04', precio_local_usd_tn: 193, precio_chicago_usd_tn: 228, tipo_cambio: 1102, volumen_exportado_tn: 560000, 'campaña': '2024/25' },
    { mes: '2025-05', precio_local_usd_tn: 188, precio_chicago_usd_tn: 223, tipo_cambio: 1128, volumen_exportado_tn: 480000, 'campaña': '2024/25' },
    { mes: '2025-06', precio_local_usd_tn: 184, precio_chicago_usd_tn: 219, tipo_cambio: 1156, volumen_exportado_tn: 410000, 'campaña': '2024/25' },
  ],
  suggestedPresetId: 'agro-price',
};

export const AGRO_EXAMPLE_DATASETS: AgroExampleDataset[] = [
  SOJA_RINDE_DEMO,
  MAIZ_MARGEN_DEMO,
  TRIGO_PRECIO_DEMO,
];

export function getAgroExampleById(id: string): AgroExampleDataset | undefined {
  return AGRO_EXAMPLE_DATASETS.find(dataset => dataset.id === id);
}

export function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Serializa columnas + filas a texto CSV (header + una línea por fila).
// Utilidad genérica compartida por datasets de ejemplo y templates CSV.
export function rowsToCsv(columns: string[], rows: Array<Record<string, string | number>>): string {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map(row => columns.map(column => csvEscape(row[column] ?? '')).join(','));
  return [header, ...lines].join('\n');
}

// Serializa un dataset de ejemplo a texto CSV (headers + filas), compatible
// con el mismo flujo de carga que usa Econometría para sus demos.
export function agroDatasetToCsv(dataset: AgroExampleDataset): string {
  return rowsToCsv(dataset.columns, dataset.rows);
}

// ── Generador de datasets sintéticos grandes ────────────────────────────────
//
// A diferencia de los 3 datasets fijos de arriba (12-30 filas, para demos
// rápidas), este generador produce datasets con volumen realista (cientos o
// miles de filas) para probar ChartBay Agro en condiciones parecidas a las de
// una fuente real (ver agroDataCatalog.ts) — SIGUEN siendo 100% sintéticos.
//
// PRNG determinista (mulberry32, dominio público): dado el mismo seed, el
// generador siempre produce exactamente el mismo dataset. No hay un patrón de
// aleatoriedad determinista preexistente en el proyecto, así que se define acá,
// mínimo y sin dependencias nuevas.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LARGE_DATASET_CROP_BASE_YIELD_KG_HA: Record<AgroCrop, number> = {
  soja: 2800, maiz: 8500, trigo: 3000, girasol: 2000, sorgo: 4500, cebada: 3200, otro: 3000,
};

const LARGE_DATASET_CROP_BASE_PRICE_USD_TN: Record<AgroCrop, number> = {
  soja: 350, maiz: 170, trigo: 200, girasol: 380, sorgo: 160, cebada: 190, otro: 250,
};

const DEFAULT_LARGE_DATASET_PROVINCES = ['Buenos Aires', 'Córdoba', 'Santa Fe', 'Entre Ríos', 'La Pampa'];

// Ancla fija (no usa la fecha real): mantiene el generador 100% reproducible,
// sin que su salida cambie con el paso del tiempo.
const LAST_SYNTHETIC_SEASON_END_YEAR = 2025;

function buildSyntheticSeasonLabels(count: number): string[] {
  const labels: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const endYear = LAST_SYNTHETIC_SEASON_END_YEAR - i;
    labels.push(`${endYear - 1}/${String(endYear).slice(2)}`);
  }
  return labels;
}

// Genera un dataset sintético grande: cultivo × campaña × provincia ×
// departamento. Por defecto 20 campañas × 5 provincias × 10 departamentos =
// 1000 filas. Mantiene producción = rinde × superficie cosechada / 1000 en
// cada fila (coherencia interna), con variación realista por campaña
// (clima/precio compartido a nivel país) y por provincia/departamento.
export function generateLargeAgroSyntheticDataset(
  options: AgroLargeSyntheticDatasetOptions = {}
): AgroExampleDataset {
  const crop = options.crop ?? 'soja';
  const seasonsCount = options.seasonsCount ?? 20;
  const provinces = options.provinces ?? DEFAULT_LARGE_DATASET_PROVINCES;
  const departmentsPerProvince = options.departmentsPerProvince ?? 10;
  const includeWeather = options.includeWeather ?? true;
  const includePrices = options.includePrices ?? true;
  const includeCosts = options.includeCosts ?? true;
  const seed = options.seed ?? 20260705;

  const random = mulberry32(seed);
  const seasons = buildSyntheticSeasonLabels(seasonsCount);
  const baseYield = LARGE_DATASET_CROP_BASE_YIELD_KG_HA[crop];
  const basePrice = LARGE_DATASET_CROP_BASE_PRICE_USD_TN[crop];

  const columns = [
    'cultivo', 'campaña', 'provincia', 'departamento',
    'superficie_sembrada_ha', 'superficie_cosechada_ha', 'produccion_tn', 'rinde_kg_ha',
    ...(includeWeather ? ['lluvia_total_mm', 'temperatura_media'] : []),
    ...(includePrices ? ['precio_usd_tn'] : []),
    ...(includeCosts ? ['costo_usd_ha'] : []),
  ];

  const rows: Array<Record<string, string | number>> = [];

  for (const season of seasons) {
    // Efecto climático de la campaña (0 = seca/mala, 1 = lluviosa/buena),
    // compartido por todas las provincias de esa campaña — como en la
    // realidad, una seca afecta a todo el país, no departamento por
    // departamento.
    const seasonQuality = random();
    const seasonRainfall = 350 + seasonQuality * 700;
    const seasonTemperature = 19.5 - seasonQuality * 3;
    const seasonPrice = basePrice * (0.8 + random() * 0.4);
    const seasonCostBase = basePrice * 1.1 * (0.85 + random() * 0.3);

    for (const province of provinces) {
      // Efecto provincia: algunas zonas rinden sistemáticamente más que otras.
      const provinceFactor = 0.85 + random() * 0.3;

      for (let deptIndex = 0; deptIndex < departmentsPerProvince; deptIndex++) {
        const department = `Departamento ${deptIndex + 1}`;
        const idiosyncraticNoise = 0.9 + random() * 0.2;
        const rindeKgHa = Math.round(
          baseYield * provinceFactor * (0.6 + seasonQuality * 0.5) * idiosyncraticNoise
        );

        const superficieSembradaHa = Math.round(5000 + random() * 45000);
        const harvestFactor = 0.9 + random() * 0.09; // 90%-99% de lo sembrado se cosecha
        const superficieCosechadaHa = Math.round(superficieSembradaHa * harvestFactor);
        const produccionTn = Math.round((rindeKgHa * superficieCosechadaHa) / 1000);

        const row: Record<string, string | number> = {
          cultivo: crop,
          'campaña': season,
          provincia: province,
          departamento: department,
          superficie_sembrada_ha: superficieSembradaHa,
          superficie_cosechada_ha: superficieCosechadaHa,
          produccion_tn: produccionTn,
          rinde_kg_ha: rindeKgHa,
        };
        if (includeWeather) {
          row.lluvia_total_mm = Math.round(seasonRainfall * (0.9 + random() * 0.2));
          row.temperatura_media = Number((seasonTemperature + (random() - 0.5)).toFixed(1));
        }
        if (includePrices) {
          row.precio_usd_tn = Number(seasonPrice.toFixed(1));
        }
        if (includeCosts) {
          row.costo_usd_ha = Math.round(seasonCostBase * (0.95 + random() * 0.1));
        }
        rows.push(row);
      }
    }
  }

  return {
    id: `${crop}_large_synthetic_demo`,
    name: `${crop} — dataset sintético grande (${seasons.length} campañas × ${provinces.length} provincias × ${departmentsPerProvince} deptos/provincia)`,
    description:
      `Dataset 100% SINTÉTICO (${rows.length} filas) generado para probar ChartBay Agro con volumen ` +
      `realista de observaciones. No proviene de ninguna fuente real — ver el catálogo de fuentes ` +
      `(agroDataCatalog.ts) para datos reales recomendados. No usar para decisiones productivas ni comerciales.`,
    crop,
    synthetic: true,
    columns,
    rows,
    suggestedPresetId: 'agro-yield',
  };
}
