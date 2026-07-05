import { getVersionConfig, type ChartBayVersion } from '../versioning/chartbayVersions';

export type EngineAction = 'lite' | 'pro_pyodide' | 'blocked';

/**
 * Decides how a run request is executed for the active ChartBay version:
 *   - 'lite'        → existing TypeScript engine (default, unchanged).
 *   - 'pro_pyodide' → Pyodide/statsmodels engine for Pro flows.
 *   - 'blocked'     → engine not available yet (Mega Pro / server_python).
 */
export function resolveEngineAction(version: ChartBayVersion): EngineAction {
  const engine = getVersionConfig(version).engine;
  if (engine === 'typescript') return 'lite';
  if (engine === 'pyodide') return 'pro_pyodide';
  return 'blocked';
}
