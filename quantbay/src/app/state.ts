import type { ParsedCSV } from '../csvParser';
import type { RegressionResult } from '../regression';
import type { LogisticResult } from '../services/analysisService';
import type { TimeSeriesAnalysisResult } from '../timeseries/types';

export type QuantBayMode = 'regression' | 'timeseries';

export interface QuantBayAppState {
  activeMode: QuantBayMode;
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
}

export const appState: QuantBayAppState = {
  activeMode: 'regression',
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
};
