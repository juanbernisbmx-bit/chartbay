// ChartBay Agro — templates de CSV recomendados para cargar datos reales.
//
// Cada template documenta las columnas mínimas que necesita un modelo agro
// (con los mismos nombres que reconoce agroColumnDetection.ts) más un par de
// filas de ejemplo — NO datos reales, sólo una plantilla para que el usuario
// arme su propio CSV con esa forma antes de subirlo a Econometría.

import type { AgroCsvTemplate } from './agroTypes';
import { rowsToCsv } from './agroExamples';

export const AGRO_CSV_TEMPLATES: AgroCsvTemplate[] = [
  {
    id: 'rinde',
    name: 'Rinde por campaña y zona',
    description:
      'Una fila por campaña + provincia (o departamento). Sirve para el modelo de rinde ' +
      '(rendimiento explicado por clima, precio e insumos).',
    requiredColumns: ['campaña', 'provincia', 'rinde_kg_ha'],
    optionalColumns: ['departamento', 'lluvia_mm', 'temperatura_media', 'precio_usd_tn', 'fertilizante_usd_ha'],
    exampleRows: [
      { 'campaña': '2023/24', provincia: 'Buenos Aires', rinde_kg_ha: 3450, lluvia_mm: 950, temperatura_media: 16.9 },
      { 'campaña': '2023/24', provincia: 'Córdoba', rinde_kg_ha: 3300, lluvia_mm: 860, temperatura_media: 17.3 },
    ],
    recommendedModelType: 'yield',
  },
  {
    id: 'clima-agregado',
    name: 'Clima agregado por zona y campaña',
    description:
      'Una fila por zona/provincia + campaña con variables climáticas agregadas (lluvia acumulada, ' +
      'temperatura media). Se usa como insumo del modelo de rinde, cruzado con producción o precio.',
    requiredColumns: ['zona', 'campaña', 'lluvia_total_mm', 'temperatura_media'],
    optionalColumns: ['humedad_media', 'heladas_dias'],
    exampleRows: [
      { zona: 'Zona núcleo', 'campaña': '2023/24', lluvia_total_mm: 920, temperatura_media: 17.1 },
      { zona: 'Zona núcleo', 'campaña': '2022/23', lluvia_total_mm: 430, temperatura_media: 18.4 },
    ],
    recommendedModelType: 'yield',
  },
  {
    id: 'precios',
    name: 'Precio local vs referencia internacional',
    description:
      'Serie por fecha (o campaña/mes) con precio local y, si está disponible, una referencia ' +
      'internacional y el tipo de cambio. Sirve para el modelo de precio y para Time Series.',
    requiredColumns: ['fecha', 'precio_local_usd_tn'],
    optionalColumns: ['precio_chicago_usd_tn', 'tipo_cambio', 'volumen_exportado_tn'],
    exampleRows: [
      { fecha: '2025-01', precio_local_usd_tn: 201, precio_chicago_usd_tn: 236, tipo_cambio: 1032 },
      { fecha: '2025-02', precio_local_usd_tn: 206, precio_chicago_usd_tn: 241, tipo_cambio: 1055 },
    ],
    recommendedModelType: 'price',
  },
  {
    id: 'margen',
    name: 'Márgenes por lote y campaña',
    description:
      'Una fila por lote (o campo) + campaña, con rinde, precio y desglose de costos. Sirve para el ' +
      'modelo de margen y para comparar contra el simulador del panel Agro.',
    requiredColumns: ['lote', 'campaña', 'rinde_kg_ha', 'precio_usd_tn', 'costo_usd_ha'],
    optionalColumns: ['flete_usd_tn', 'alquiler_usd_ha', 'margen_bruto_usd_ha'],
    exampleRows: [
      { lote: 'Lote 1', 'campaña': '2023/24', rinde_kg_ha: 3100, precio_usd_tn: 305, costo_usd_ha: 620 },
      { lote: 'Lote 2', 'campaña': '2023/24', rinde_kg_ha: 2900, precio_usd_tn: 305, costo_usd_ha: 640 },
    ],
    recommendedModelType: 'margin',
  },
  {
    id: 'produccion',
    name: 'Producción por cultivo, campaña y provincia',
    description:
      'Una fila por cultivo + campaña + provincia con superficie y producción. Sirve para el modelo ' +
      'de producción (escala productiva) y para reconstruir el rinde si no viene ya calculado.',
    requiredColumns: ['cultivo', 'campaña', 'provincia', 'superficie_sembrada_ha', 'produccion_tn'],
    optionalColumns: ['superficie_cosechada_ha', 'rinde_kg_ha'],
    exampleRows: [
      { cultivo: 'soja', 'campaña': '2023/24', provincia: 'Santa Fe', superficie_sembrada_ha: 1060000, produccion_tn: 3551000 },
      { cultivo: 'maiz', 'campaña': '2023/24', provincia: 'Córdoba', superficie_sembrada_ha: 1620000, produccion_tn: 12000000 },
    ],
    recommendedModelType: 'production',
  },
];

export function getAgroCsvTemplate(id: string): AgroCsvTemplate | undefined {
  return AGRO_CSV_TEMPLATES.find(template => template.id === id);
}

export function listAgroCsvTemplates(): AgroCsvTemplate[] {
  return AGRO_CSV_TEMPLATES;
}

// Serializa un template a texto CSV (columnas requeridas + opcionales como
// header, filas de ejemplo como cuerpo) para copiar o descargar desde la UI.
export function agroCsvTemplateToCsv(template: AgroCsvTemplate): string {
  const columns = [...template.requiredColumns, ...template.optionalColumns];
  return rowsToCsv(columns, template.exampleRows);
}
