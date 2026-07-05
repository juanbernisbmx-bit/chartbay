// ChartBay Agro — catálogo de fuentes de datos agro reales.
//
// Este módulo es PURA REFERENCIA: no descarga nada, no llama a ninguna API,
// no valida URLs. Documenta de qué fuentes públicas podría venir un dataset
// real y qué preset de Agro conviene aplicarle. La carga sigue siendo
// siempre manual (el usuario exporta un CSV desde la fuente y lo sube a
// Econometría); loadMethod está fijo en 'manual_csv' en todo el catálogo.

import type { AgroDataSource, AgroModelType } from './agroTypes';

export const AGRO_DATA_CATALOG: AgroDataSource[] = [
  {
    id: 'estimaciones-agricolas-argentina',
    name: 'Estimaciones Agrícolas Argentina',
    provider: 'MAGyP / Secretaría de Agricultura, Ganadería y Pesca',
    granularity: ['cultivo', 'campaña', 'provincia', 'departamento'],
    variables: ['superficie sembrada', 'superficie cosechada', 'producción', 'rendimiento'],
    recommendedFor: ['yield', 'production'],
    loadMethod: 'manual_csv',
    notes:
      'Serie histórica oficial por cultivo, campaña y departamento. Sirve como base para modelos ' +
      'de rinde (rendimiento ~ clima) y de producción (producción ~ superficie, rinde). Exportar el ' +
      'recorte deseado como CSV desde el sitio del organismo y cargarlo manualmente en Econometría.',
  },
  {
    id: 'precios-fob-granos-argentina',
    name: 'Precios FOB Granos Argentina',
    provider: 'MAGyP',
    granularity: ['producto', 'fecha'],
    variables: ['precio FOB (USD)'],
    recommendedFor: ['price'],
    loadMethod: 'manual_csv',
    notes:
      'Serie de precios FOB por producto y fecha. Sirve para modelos de precio (transmisión de precio ' +
      'internacional, tipo de cambio) y para el modo Time Series de Econometría si se ordena por fecha.',
  },
  {
    id: 'faostat',
    name: 'FAOSTAT',
    provider: 'FAO (Organización de las Naciones Unidas para la Alimentación y la Agricultura)',
    granularity: ['país', 'año', 'producto'],
    variables: ['producción', 'área', 'rendimiento', 'comercio'],
    recommendedFor: ['yield', 'production', 'price'],
    loadMethod: 'manual_csv',
    notes:
      'Base internacional comparable entre países. Útil para contrastar rindes o producción de ' +
      'Argentina contra otros orígenes, o para series largas cuando el detalle provincial no hace falta.',
  },
];

export function getAgroDataSourcesByModelType(modelType: AgroModelType): AgroDataSource[] {
  return AGRO_DATA_CATALOG.filter(source => source.recommendedFor.includes(modelType));
}

export function getAgroDataSourceById(id: string): AgroDataSource | undefined {
  return AGRO_DATA_CATALOG.find(source => source.id === id);
}
