import type { RLSConstraint } from './rls';

interface Term {
  coefficient: number;
  varIndex: number | null; // null = numeric constant
}

/**
 * Resolve a variable token to its 0-based index in xNames.
 * Accepts both "beta_varname" (strips the prefix) and bare "varname".
 * Falls back to the bare token if the stripped form is not found, which
 * handles column names that literally start with "beta_".
 */
function resolveVar(token: string, xNames: string[]): number | null {
  if (token.startsWith('beta_')) {
    const stripped = token.slice(5);
    const idx = xNames.indexOf(stripped);
    if (idx >= 0) return idx;
  }
  const idx = xNames.indexOf(token);
  return idx >= 0 ? idx : null;
}

/**
 * Tokenize one side of a restriction expression into signed terms.
 *
 * Accepts:
 *   - plain variables:          x1  /  beta_x1
 *   - coefficient * variable:   2*x1  /  1.5*beta_x2
 *   - numeric constants:        4  /  -3.5
 *
 * Signs (+/-) are attached to each term; a leading "+" is prepended
 * automatically so every term starts with an explicit sign character.
 */
function tokenize(expr: string, xNames: string[]): Term[] | string {
  const s = expr.replace(/\s+/g, '');
  if (s === '') return 'Expresión vacía.';

  const signed = /^[+-]/.test(s) ? s : '+' + s;

  // Split at every + or - that is not at position 0
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < signed.length; i++) {
    const ch = signed[i];
    if ((ch === '+' || ch === '-') && i > 0) {
      parts.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) parts.push(cur);

  const terms: Term[] = [];
  for (const part of parts) {
    if (!part) continue;
    const sign = part[0] === '-' ? -1 : 1;
    const body = part.slice(1);

    if (!body) return `Término vacío en "${expr}".`;

    if (/^\d*\.?\d+$/.test(body)) {
      // pure numeric constant, e.g. "4" or "1.5"
      terms.push({ coefficient: sign * parseFloat(body), varIndex: null });
    } else if (/^\d*\.?\d+\*/.test(body)) {
      // coefficient * variable, e.g. "2*x1" or "1.5*beta_x2"
      const starAt = body.indexOf('*');
      const coeff = sign * parseFloat(body.slice(0, starAt));
      const varToken = body.slice(starAt + 1);
      if (!varToken) return `Falta el nombre de variable después de "*" en "${part}".`;
      const idx = resolveVar(varToken, xNames);
      if (idx === null) {
        return `Variable "${varToken}" no está entre los regresores X seleccionados (${xNames.join(', ')}).`;
      }
      terms.push({ coefficient: coeff, varIndex: idx });
    } else if (/^[a-zA-Z_]/.test(body)) {
      // bare variable name (implicit coefficient 1), e.g. "x1" or "beta_x2"
      const idx = resolveVar(body, xNames);
      if (idx === null) {
        return `Variable "${body}" no está entre los regresores X seleccionados (${xNames.join(', ')}).`;
      }
      terms.push({ coefficient: sign, varIndex: idx });
    } else {
      return `No pude interpretar el término "${part}". Revisá la sintaxis.`;
    }
  }

  return terms;
}

/**
 * Parse a user-typed linear restriction string into an RLSConstraint.
 *
 * Supported forms (spaces optional, beta_ prefix optional):
 *   beta_x1 = beta_x2         →  R=[0,1,-1,...], q=[0]
 *   beta_x1 + beta_x2 = 4     →  R=[0,1,1,...],  q=[4]
 *   beta_x1 - beta_x2 = 0     →  R=[0,1,-1,...], q=[0]
 *   beta_x3 = 0               →  R=[0,...,1],    q=[0]
 *   x1 = x2  /  x1 + x2 = 4  →  same as above
 *
 * Returns:
 *   ''             – input was blank; caller should run plain OLS
 *   RLSConstraint  – successfully parsed
 *   string         – non-empty error message; caller should reject and show it
 */
export function parseRLSRestriction(
  input: string,
  xNames: string[],
): RLSConstraint | string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  const eqAt = trimmed.indexOf('=');
  if (eqAt === -1) {
    return 'Falta el "=" en la restricción. Ejemplo: beta_x1 = beta_x2.';
  }
  if (trimmed.indexOf('=', eqAt + 1) !== -1) {
    return 'La restricción tiene más de un "=". Debe tener exactamente uno.';
  }

  const lhsStr = trimmed.slice(0, eqAt).trim();
  const rhsStr = trimmed.slice(eqAt + 1).trim();
  if (!lhsStr) return 'El lado izquierdo de la restricción está vacío.';
  if (!rhsStr) return 'El lado derecho de la restricción está vacío.';

  const lhs = tokenize(lhsStr, xNames);
  if (typeof lhs === 'string') return lhs;

  const rhs = tokenize(rhsStr, xNames);
  if (typeof rhs === 'string') return rhs;

  // Build the single-row R vector and scalar q from R*beta = q.
  // Coefficient layout: [beta0_intercept, beta1 (x[0]), beta2 (x[1]), ...]
  const k = xNames.length;
  const Rrow = new Array<number>(k + 1).fill(0);
  let q = 0;

  for (const t of lhs) {
    if (t.varIndex !== null) {
      Rrow[t.varIndex + 1] += t.coefficient; // +1 to skip the intercept slot
    } else {
      q -= t.coefficient; // constant on LHS becomes negative on RHS
    }
  }
  for (const t of rhs) {
    if (t.varIndex !== null) {
      Rrow[t.varIndex + 1] -= t.coefficient; // variable on RHS moves to LHS
    } else {
      q += t.coefficient; // constant on RHS stays
    }
  }

  if (Rrow.every(v => v === 0)) {
    return 'La restricción es trivial (ambos lados son idénticos). Ingresá una restricción con efecto real.';
  }
  if (Rrow[0] !== 0) {
    return (
      'Esta restricción involucra el intercepto (beta0). ' +
      'Por ahora solo se aceptan restricciones sobre los coeficientes de los regresores.'
    );
  }

  return { R: [Rrow], q: [q], label: trimmed };
}
