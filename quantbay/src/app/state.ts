import type { ParsedCSV } from '../csvParser';
import type { RegressionResult } from '../regression';
import type { LogisticResult } from '../services/analysisService';
import type { TimeSeriesAnalysisResult } from '../timeseries/types';
import type { FunctionalForm } from '../functionalForms';
import type { CategoricalVariableInfo } from '../categoricalEncoding';
import type { BreuschPaganResult } from '../heteroskedasticity';
import type { ChartBayVersion } from '../versioning/chartbayVersions';

export type QuantBayMode = 'regression' | 'timeseries';

export interface QuantBayAppState {
  activeMode: QuantBayMode;
  activeVersion: ChartBayVersion;
  activeFunctionalForm: FunctionalForm;
  csvData: ParsedCSV | null;
  /** Run-log lines produced while loading (cleaner actions, warnings). */
  loadNotes?: string[];
  loadEngine?: 'wasm' | 'papaparse';
  /** Raw CSV text of the loaded file/demo — needed by the Pro (Pyodide) engine. */
  /**
   * El CSV como texto. Solo lo necesita el motor Pro (Pyodide), que le pasa el
   * archivo entero a Python. En el camino Lite queda en null: leerlo costaría
   * el doble del archivo en heap — los strings de JS son UTF-16 — justo lo que
   * el limpiador en WASM evita procesando por chunks.
   */
  csvText: string | null;
  /** El archivo original, para leer el texto recién si Pro lo pide. */
  csvFile: File | null;
  activeChart: any;
  residFittedChart: any;
  residHistChart: any;
  lastResult: RegressionResult | null;
  lastCorr: number[][] | null;
  lastCorrCols: string[] | null;
  lastVIF: number[] | null;
  lastLogit: LogisticResult | null;
  lastTimeSeriesResult: TimeSeriesAnalysisResult | null;
  lastDropped: number;
  activeDemoId: string | null;
  lastCategoricalInfo: CategoricalVariableInfo[];
  lastCategoricalWarnings: string[];
  lastHeteroskedasticity: BreuschPaganResult | null;
}

export const appState: QuantBayAppState = {
  activeMode: 'regression',
  activeVersion: 'lite',
  activeFunctionalForm: 'lin-lin',
  csvData: null,
  csvText: null,
  csvFile: null,
  activeChart: null,
  residFittedChart: null,
  residHistChart: null,
  lastResult: null,
  lastCorr: null,
  lastCorrCols: null,
  lastVIF: null,
  lastLogit: null,
  lastTimeSeriesResult: null,
  lastDropped: 0,
  activeDemoId: null,
  lastCategoricalInfo: [],
  lastCategoricalWarnings: [],
  lastHeteroskedasticity: null,
};
