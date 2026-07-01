// Functional form support for the ChartBay OLS engine.
//
// Strategy: transform Y and/or X BEFORE passing them to runOLS.
// runOLS itself is not modified.
//
// Supported forms:
//   lin-lin  →  Y  = β0 + β1·X           (no transform)
//   log-lin  →  ln(Y) = β0 + β1·X        (log Y only)
//   lin-log  →  Y  = β0 + β1·ln(X)       (log X only)
//   log-log  →  ln(Y) = β0 + β1·ln(X)    (log both)

export type FunctionalForm = 'lin-lin' | 'log-lin' | 'lin-log' | 'log-log';

export interface TransformResult {
  y: number[];
  X: number[][];
  yName: string;
  xNames: string[];
  yLogged: boolean;
  loggedXIndices: number[];   // indices into xNames that were logged
}

function safeLog(values: number[], label: string): number[] {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      throw new Error(
        `"${label}" contiene valores no finitos (fila ${i}). Revisá los datos antes de aplicar logaritmo.`
      );
    }
    if (v <= 0) {
      throw new Error(
        `"${label}" tiene un valor <= 0 en la fila ${i} (valor: ${v}). El logaritmo natural no está definido para valores no positivos.`
      );
    }
  }
  return values.map(v => Math.log(v));
}

function validateFinite(values: number[], label: string): void {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) {
      throw new Error(
        `"${label}" contiene un valor no finito (${v}) en la fila ${i}. Revisá los datos originales.`
      );
    }
  }
}

// Transform y and X arrays according to the chosen functional form.
// Does NOT mutate the inputs.
// Throws a clear, pedagogical error on invalid values.
//
// noLogXNames: X columns to exclude from the log-X transform even when the
// form calls for it (lin-log / log-log). Used for dummy columns from
// categorical encoding — a 0/1 dummy must never be logged.
export function applyFunctionalTransform(
  y: number[],
  X: number[][],
  yName: string,
  xNames: string[],
  form: FunctionalForm,
  noLogXNames: ReadonlySet<string> = new Set()
): TransformResult {
  const logY = form === 'log-lin' || form === 'log-log';
  const logXBase = form === 'lin-log' || form === 'log-log';
  const shouldLogX = (name: string): boolean => logXBase && !noLogXNames.has(name);
  const loggedXIndices = xNames.reduce<number[]>((acc, name, i) => {
    if (shouldLogX(name)) acc.push(i);
    return acc;
  }, []);

  // Validate Y
  if (logY) {
    const transformedY = safeLog(y, yName);
    const transformedX = X.map((row, rowIndex) =>
      row.map((v, colIndex) => {
        const name = xNames[colIndex];
        if (!Number.isFinite(v)) {
          throw new Error(
            `"${name}" contiene un valor no finito (${v}) en la fila ${rowIndex}.`
          );
        }
        return shouldLogX(name) ? (() => {
          if (v <= 0) throw new Error(`"${name}" tiene un valor <= 0 en la fila ${rowIndex} (valor: ${v}). El logaritmo no está definido para valores no positivos.`);
          return Math.log(v);
        })() : v;
      })
    );
    return {
      y: transformedY,
      X: transformedX,
      yName: `ln(${yName})`,
      xNames: xNames.map(n => shouldLogX(n) ? `ln(${n})` : n),
      yLogged: true,
      loggedXIndices,
    };
  }

  // Y not logged
  validateFinite(y, yName);
  const transformedX = X.map((row, rowIndex) =>
    row.map((v, colIndex) => {
      const name = xNames[colIndex];
      if (shouldLogX(name)) {
        if (!Number.isFinite(v)) {
          throw new Error(`"${name}" contiene un valor no finito (${v}) en la fila ${rowIndex}.`);
        }
        if (v <= 0) {
          throw new Error(`"${name}" tiene un valor <= 0 en la fila ${rowIndex} (valor: ${v}). El logaritmo no está definido para valores no positivos.`);
        }
        return Math.log(v);
      }
      if (!Number.isFinite(v)) {
        throw new Error(`"${name}" contiene un valor no finito (${v}) en la fila ${rowIndex}.`);
      }
      return v;
    })
  );
  return {
    y: [...y],
    X: transformedX,
    yName,
    xNames: xNames.map(n => shouldLogX(n) ? `ln(${n})` : n),
    yLogged: false,
    loggedXIndices,
  };
}

// ---------------------------------------------------------------------------
// Coefficient interpretation
// ---------------------------------------------------------------------------

export interface CoefficientInterpretation {
  form: FunctionalForm;
  coefficientName: string;
  beta: number;
  kind: 'absolute' | 'semielasticity' | 'semielasticity-x' | 'elasticity';
  approxRule: string;
  exactEffect: string | null;
}

// Returns a structured, pedagogical interpretation of a single slope coefficient.
// Pass the ORIGINAL variable names (before log-prefix), not 'ln(...)' wrapped names.
export function interpretFunctionalCoefficient(
  form: FunctionalForm,
  coefficientName: string,
  beta: number,
): CoefficientInterpretation {
  const b = beta.toFixed(6);
  const b4 = beta.toFixed(4);

  switch (form) {
    case 'lin-lin':
      return {
        form,
        coefficientName,
        beta,
        kind: 'absolute',
        approxRule:
          `Un aumento de 1 unidad en "${coefficientName}" se asocia con un cambio de ${b4} unidades en Y, manteniendo el resto constante.`,
        exactEffect: null,
      };

    case 'log-lin': {
      const approxPct = (beta * 100).toFixed(4);
      const exactPct = (100 * (Math.exp(beta) - 1)).toFixed(4);
      return {
        form,
        coefficientName,
        beta,
        kind: 'semielasticity',
        approxRule:
          `Un aumento de 1 unidad en "${coefficientName}" se asocia con un cambio aproximado de ${approxPct}% en Y.`,
        exactEffect:
          `Efecto exacto: 100·(exp(${b}) - 1) = ${exactPct}%.`,
      };
    }

    case 'lin-log': {
      const approxUnits = (beta / 100).toFixed(6);
      return {
        form,
        coefficientName,
        beta,
        kind: 'semielasticity-x',
        approxRule:
          `Un aumento de 1% en "${coefficientName}" se asocia con un cambio aproximado de ${approxUnits} unidades en Y (= β / 100 = ${b4} / 100).`,
        exactEffect: null,
      };
    }

    case 'log-log':
      return {
        form,
        coefficientName,
        beta,
        kind: 'elasticity',
        approxRule:
          `β = ${b4} es una elasticidad: un aumento de 1% en "${coefficientName}" se asocia con un cambio aproximado de ${b4}% en Y.`,
        exactEffect: null,
      };
  }
}
