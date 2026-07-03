// Guards ChartBay Pro (Pyodide) against silently ignoring a user selection it
// cannot execute yet, or executing something ambiguous. resolveEngineAction()
// already blocks whole run modes (auto-repair, time series); this covers
// selections *within* a regular run. Functional forms, RLS restrictions and
// categorical dummies (see pro/pyodide/pythonOlsRunner.ts, categoricalEncoding.ts)
// are all executed for real now — this module only blocks the specific cases
// that would be ambiguous or misleading to run.

import { validateRLSConstraint, type RLSConstraint } from '../rls';

export type ProCapabilityReason = 'rls-invalid' | 'categorical-invalid';

export interface ProCapabilityBlock {
  reason: ProCapabilityReason;
  message: string;
}

export function checkProCapability(args: {
  rlsConstraint: RLSConstraint | null | undefined;
  // Categorical X columns the user selected that could NOT be turned into
  // dummies (e.g. a single useful category after accounting for missing
  // values) — encodeCategoricalX() already drops these silently with a
  // warning for Lite; Pro is stricter and blocks the run instead, since
  // silently estimating without a variable the user explicitly selected
  // would be a misleading result.
  invalidCategoricalNames: string[];
  parameterCount: number;
}): ProCapabilityBlock | null {
  if (args.invalidCategoricalNames.length > 0) {
    const plural = args.invalidCategoricalNames.length > 1;
    return {
      reason: 'categorical-invalid',
      message:
        `La variable categórica${plural ? 's' : ''} ${args.invalidCategoricalNames.join(', ')} no ` +
        `tiene${plural ? 'n' : ''} suficientes categorías válidas para crear dummies. Revisá los datos o ` +
        `deseleccioná esa${plural ? 's' : ''} variable${plural ? 's' : ''} antes de calcular en Pro.`,
    };
  }

  if (args.rlsConstraint) {
    // Reuses Lite's own shape/finiteness validation (rls.ts) so an invalid
    // restriction is rejected the same way in both engines, with the same
    // wording for "why" — e.g. wrong number of columns, more restrictions
    // than parameters, a variable that no longer exists in the selection.
    try {
      validateRLSConstraint(args.rlsConstraint, args.parameterCount);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        reason: 'rls-invalid',
        message:
          `La restricción no puede evaluarse en Pro porque no coincide con los coeficientes estimados. ${reason}`,
      };
    }
  }

  return null;
}
