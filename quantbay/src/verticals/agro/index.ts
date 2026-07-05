// ChartBay Agro — API pública del vertical.
//
// verticals/agro = capa aplicada; el motor econométrico común vive en src/
// (regression.ts, functionalForms.ts, timeseries/, pro/). Este vertical no
// duplica ninguna de esas piezas.

export * from './agroTypes';
export { detectAgroColumns, normalizeAgroHeader } from './agroColumnDetection';
export {
  AGRO_MODEL_PRESETS,
  agroRoleLabel,
  getAgroPresetById,
  suggestAgroModelPresets,
} from './agroModelPresets';
export {
  calculateAgroGrossMargin,
  calculateAgroMargin,
  calculateAgroMarginPerHectare,
  calculateAgroRevenue,
  calculateAgroTotalCost,
  calculateBreakEvenPrice,
  calculateBreakEvenYield,
  runAgroMarginScenarios,
  yieldToTonsPerHa,
} from './agroMargin';
export {
  fromRegressionResult,
  interpretAgroRegressionResult,
  type ModelRunResultLike,
} from './agroInterpretation';
export {
  AGRO_EXAMPLE_DATASETS,
  MAIZ_MARGEN_DEMO,
  SOJA_RINDE_DEMO,
  TRIGO_PRECIO_DEMO,
  agroDatasetToCsv,
  getAgroExampleById,
} from './agroExamples';
export { CHARTBAY_VERTICALS, isVerticalEnabled, type ChartBayVerticalId } from './agroFeatureFlags';
export { initAgroVertical } from './agroView';
