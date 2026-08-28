import type { PyodideOlsInput, PyodideOlsPhase } from './pythonOlsRunner';
import type { PyodideOlsResult } from './proResultTypes';
import type { PyodideTimeSeriesInput, PyodideTimeSeriesResult } from './proTimeSeriesResultTypes';
import type { PyodideTimeSeriesPhase } from './pythonTimeSeriesRunner';

export type ProWorkerRequest =
  | { id: number; kind: 'ols'; input: PyodideOlsInput }
  | { id: number; kind: 'timeseries'; input: PyodideTimeSeriesInput };

export type ProWorkerResponse =
  | { id: number; kind: 'phase'; phase: PyodideOlsPhase | PyodideTimeSeriesPhase }
  | { id: number; kind: 'ols-result'; result: PyodideOlsResult }
  | { id: number; kind: 'timeseries-result'; result: PyodideTimeSeriesResult };
