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
  form: FunctionalForm
): string | null {
  try {
    const { X, y } = getValidRows(csvData.rows, yName, xNames);
    applyFunctionalTransform(y, X, yName, xNames, form);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
