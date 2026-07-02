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
import type { ParsedCSV } from '../csvParser';
import type { FunctionalForm } from '../functionalForms';
import type { RLSConstraint } from '../rls';
import type { ProComparison, ProRlsComparison } from '../ui/proView';

function buildRlsTestComparison(
  csvData: ParsedCSV,
  yName: string,
  xNames: string[],
  form: FunctionalForm,
  rlsConstraint: RLSConstraint,
  proRlsTest: { label: string; fStat: number | null; fPValue: number | null }
): ProRlsComparison | null {
  try {
    const liteRestricted = runRegressionMode(csvData, yName, xNames, rlsConstraint, form);
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
    const lite = runRegressionMode(csvData, yName, xNames, undefined, form);
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
