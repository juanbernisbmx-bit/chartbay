// ChartBay — feature flags de verticales.
//
// Los verticales son capas aplicadas sobre el motor econométrico común.
// Apagar un vertical acá lo saca de la UI sin romper el build: los módulos
// del vertical siguen compilando y testeándose, sólo no se inicializa su
// vista. La UI de Econometría NUNCA depende de estos flags.

export const CHARTBAY_VERTICALS = {
  econometria: true,
  agro: true,
  finanzas: false,
} as const;

export type ChartBayVerticalId = keyof typeof CHARTBAY_VERTICALS;

export function isVerticalEnabled(id: ChartBayVerticalId): boolean {
  return CHARTBAY_VERTICALS[id];
}
