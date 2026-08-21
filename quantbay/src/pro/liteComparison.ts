// Best-effort cross-check: runs the Lite engine on the same Y/X selection
// AND THE SAME FUNCTIONAL FORM Pro just estimated, then pairs coefficients by
// name plus R² and n. Comparing different forms (e.g. Pro log-log vs Lite
// lin-lin) would be meaningless — a log-log slope is an elasticity, a lin-lin
// slope is not — so the form is a required argument, not a default.
//
// The COEFFICIENT comparison is always Lite-unrestricted vs Pro-unrestricted,
// even when an RLS constraint is active: Lite re-estimates β under Rβ = q
// (rls.ts) while Pro only tests the restriction against the unrestricted fit
// (see pro/pyodide/pythonOlsRunner.ts) — comparing those coefficients directly
// would silently compare two different estimators. The RESTRICTION TEST itself
// is compared separately below, since both engines compute the same classical
// F-test formula on the (Lite) restricted-vs-unrestricted RSS decomposition /
// (Pro) statsmodels Wald test — a meaningful, apples-to-apples cross-check.
//
// Any Lite failure just skips the comparison.

import { runRegressionMode } from '../modes/regressionMode';
import type { AnalysisOptions } from '../services/analysisService';
import type { ParsedCSV } from '../csvParser';
import type { FunctionalForm } from '../functionalForms';
import type { RLSConstraint } from '../rls';
import type { ProComparison, ProRlsComparison } from '../ui/proView';

// El runner Pro hace pandas .dropna() sin preguntar, así que Lite tiene que
// estimar sobre la misma submuestra o la comparación deja de ser válida (y con
// faltantes en el CSV, Lite tiraba y la comparación se saltaba en silencio).
const LITE_COMPARISON_OPTIONS: AnalysisOptions = { dropIncompleteRows: true };

function buildRlsTestComparison(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  form: FunctionalForm,
  rlsConstraint: RLSConstraint,
  proRlsTest: { label: string; fStat: number | null; fPValue: number | null }
): ProRlsComparison | null {
  try {
    const liteRestricted = runRegressionMode(csvData, yName, xNames, rlsConstraint, form, LITE_COMPARISON_OPTIONS);
    const { fStatConstraint, fPValueConstraint } = liteRestricted.result;
    return {
      label: proRlsTest.label,
      liteFStat: typeof fStatConstraint === 'number' && Number.isFinite(fStatConstraint) ? fStatConstraint : null,
      litePValue: typeof fPValueConstraint === 'number' && Number.isFinite(fPValueConstraint) ? fPValueConstraint : null,
    };
  } catch {
    return null;
  }
}

export function buildLiteComparison(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  form: FunctionalForm,
  proResult: {
    coefficients?: Array<{ name: string; estimate: number }>;
    rlsTest?: { label: string; fStat: number | null; fPValue: number | null };
  },
  rlsConstraint?: RLSConstraint
): ProComparison | null {
  if (!proResult.coefficients) return null;
  try {
    const lite = runRegressionMode(csvData, yName, xNames, undefined, form, LITE_COMPARISON_OPTIONS);
    const liteByName = new Map<string, number>([
      ['Intercept', lite.result.intercept],
      ...lite.result.featureNames.map((name, i) => [name, lite.result.coefficients[i]] as [string, number]),
    ]);
    const rows = proResult.coefficients
      .filter(c => liteByName.has(c.name))
      .map(c => ({ name: c.name, liteEstimate: liteByName.get(c.name)!, proEstimate: c.estimate }));

    const rlsTest =
      rlsConstraint && proResult.rlsTest
        ? buildRlsTestComparison(csvData, yName, xNames, form, rlsConstraint, proResult.rlsTest)
        : undefined;

    // Zero coefficients matched by name even though Pro reported some: Lite
    // and Pro built different design matrices for this Y/X/form selection
    // (e.g. a categorical variable that ended up encoded into different
    // dummies on each side). In practice this shouldn't happen — both engines
    // call the same encodeCategoricalX — but this is the safety net so a
    // divergence surfaces as an explicit message instead of a silently
    // meaningless R²/coefficient comparison (comparing stats across designs
    // that don't share a single coefficient is not "approximately right", it's
    // wrong).
    if (rows.length === 0 && proResult.coefficients.length > 0) {
      return {
        rows: [],
        liteRSquared: null,
        liteNobs: null,
        rlsTest,
        designMismatch:
          'La comparación Lite vs Pro se omitió porque los motores no construyeron la misma matriz de diseño.',
      };
    }

    return {
      rows,
      liteRSquared: Number.isFinite(lite.result.rSquared) ? lite.result.rSquared : null,
      liteNobs: lite.result.nObs,
      rlsTest,
    };
  } catch {
    return null;
  }
}
