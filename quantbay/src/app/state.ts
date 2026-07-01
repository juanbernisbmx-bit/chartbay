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
