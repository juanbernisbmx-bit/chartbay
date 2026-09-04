import type { PyodideOlsInput, PyodideOlsPhase } from './pythonOlsRunner';
import type { PyodideOlsResult } from './proResultTypes';
import type { PyodideTimeSeriesInput, PyodideTimeSeriesResult } from './proTimeSeriesResultTypes';
import type { PyodideTimeSeriesPhase } from './pythonTimeSeriesRunner';
import type { PyodideLoadPhase } from './pyodideTypes';

export type ProWorkerWarmupResult =
  | { ok: true }
  | { ok: false; error: string };

export type ProWorkerRequest =
  | { id: number; kind: 'warmup' }
  | { id: number; kind: 'ols'; input: PyodideOlsInput }
  | { id: number; kind: 'timeseries'; input: PyodideTimeSeriesInput };

export type ProWorkerResponse =
  | { id: number; kind: 'phase'; phase: PyodideOlsPhase | PyodideTimeSeriesPhase | PyodideLoadPhase }
  | { id: number; kind: 'warmup-result'; result: ProWorkerWarmupResult }
  | { id: number; kind: 'ols-result'; result: PyodideOlsResult }
  | { id: number; kind: 'timeseries-result'; result: PyodideTimeSeriesResult };
