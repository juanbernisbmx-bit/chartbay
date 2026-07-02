// Guards ChartBay Pro (Pyodide) against silently ignoring a user selection it
// cannot execute yet. resolveEngineAction() already blocks whole run modes
// (auto-repair, time series); this covers selections *within* a regular run.
// Functional forms and RLS restrictions are executed for real (see
// pro/pyodide/pythonOlsRunner.ts); categorical dummies are still not
// implemented in Pro and remain a hard block.

import { validateRLSConstraint, type RLSConstraint } from '../rls';

export type ProCapabilityReason = 'rls-invalid' | 'categorical';

export interface ProCapabilityBlock {
  reason: ProCapabilityReason;
  message: string;
}

export function checkProCapability(args: {
  rlsConstraint: RLSConstraint | null | undefined;
  categoricalXNames: string[];
  parameterCount: number;
}): ProCapabilityBlock | null {
  if (args.categoricalXNames.length > 0) {
    const plural = args.categoricalXNames.length > 1;
    return {
      reason: 'categorical',
      message:
        `El modo Pro actual todavía no ejecuta esta opción (variable${plural ? 's' : ''} categórica${plural ? 's' : ''}: ` +
        `${args.categoricalXNames.join(', ')}). Para evitar resultados engañosos, usá ChartBay Lite o ` +
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
