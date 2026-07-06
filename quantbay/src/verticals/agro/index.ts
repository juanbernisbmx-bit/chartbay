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
  buildAgroSensitivityMatrix,
  calculateAgroGrossMargin,
  calculateAgroMargin,
  calculateAgroMarginPerHectare,
  calculateAgroRevenue,
  calculateAgroTotalCost,
  calculateBreakEvenPrice,
  calculateBreakEvenYield,
  formatAgroMarginSummary,
  formatAgroSensitivityMatrix,
  runAgroMarginScenarios,
  yieldToTonsPerHa,
  type AgroSensitivityOptions,
} from './agroMargin';
export {
  fromPyodideOlsResult,
  fromRegressionResult,
  interpretAgroRegressionResult,
  type AgroPyodideResultLike,
  type ModelRunResultLike,
} from './agroInterpretation';
export {
  AGRO_EXAMPLE_DATASETS,
  MAIZ_MARGEN_DEMO,
  SOJA_RINDE_DEMO,
  TRIGO_PRECIO_DEMO,
  agroDatasetToCsv,
  generateLargeAgroSyntheticDataset,
  getAgroExampleById,
  rowsToCsv,
} from './agroExamples';
export {
  AGRO_DATA_CATALOG,
  getAgroDataSourceById,
  getAgroDataSourcesByModelType,
} from './agroDataCatalog';
export {
  AGRO_CSV_TEMPLATES,
  agroCsvTemplateToCsv,
  getAgroCsvTemplate,
  listAgroCsvTemplates,
} from './agroCsvTemplates';
export { assessAgroModelCapacity } from './agroModelCapacity';
export { CHARTBAY_VERTICALS, isVerticalEnabled, type ChartBayVerticalId } from './agroFeatureFlags';
export {
  clearAgroContext,
  hasActiveAgroContext,
  hideAgroInterpretationPanels,
  initAgroVertical,
  presentAgroInterpretationForPro,
  presentAgroInterpretationForRegression,
  type AgroDatasetLoadParams,
  type AgroDatasetLoadResult,
  type AgroEconometriaBridge,
} from './agroView';
