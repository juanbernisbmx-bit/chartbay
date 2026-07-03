// Client-side pre-check for ChartBay Pro functional forms.
//
// Reuses the exact same transform/validation Lite already runs
// (applyFunctionalTransform) so the log-domain error messages are identical
// between engines, and so Pro fails fast — before paying the multi-second
// cost of loading Pyodide/numpy/pandas/statsmodels — on data that would fail
// anyway. The Python script also re-validates the domain on its own parsed
// data (see pro/pyodide/pythonOlsRunner.ts): this check does not replace that
// one, it just gives faster feedback for the common case.

import { getValidRows, type ParsedCSV } from '../csvParser';
import { applyFunctionalTransform, type FunctionalForm } from '../functionalForms';

/**
 * Returns a pedagogical error message if the chosen functional form is not
 * valid for the current Y/X selection (log of a non-positive value), or null
 * if the domain is valid.
 */
export function checkProFunctionalDomain(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  form: FunctionalForm,
  // Dummy columns from categorical encoding — must never be checked against
  // the log domain (they're always 0/1, and 0 would otherwise look invalid).
  noLogXNames: ReadonlySet<string> = new Set()
): string | null {
  // A log-X form (lin-log/log-log) with every selected X excluded from
  // logging (i.e. X is purely categorical dummies) would otherwise silently
  // degrade to "no X gets logged" — numerically identical to lin-lin/log-lin
  // while still being labeled log-X. Block instead of misleading the label.
  const logXBase = form === 'lin-log' || form === 'log-log';
  if (logXBase && xNames.length > 0 && xNames.every(name => noLogXNames.has(name))) {
    return 'No se puede aplicar log(X) a una variable categórica. Usá lin-lin/log-lin o agregá una X numérica.';
  }
  try {
    const { X, y } = getValidRows(csvData.rows, yName, xNames);
    applyFunctionalTransform(y, X, yName, xNames, form, noLogXNames);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
