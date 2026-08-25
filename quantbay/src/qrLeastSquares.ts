// Mínimos cuadrados por descomposición QR de Householder.
//
// Existe porque `runOLS` resuelve las ecuaciones normales: arma X'X y lo
// invierte con Gauss-Jordan. Para un diseño común eso coincide con statsmodels
// hasta el sexto decimal, pero X'X eleva al cuadrado el número de condición, y
// hay un diseño en la app donde eso destruye el resultado: la regresión del
// test ADF, que mezcla una columna de NIVELES con once de DIFERENCIAS de la
// misma serie. En un índice de precios los niveles van de 100 a 450 y las
// diferencias de 1 a 10, y encima las once diferencias rezagadas son casi
// colineales entre sí. Medido sobre un IPC de 72 meses: las ecuaciones
// normales daban un estadístico de 0.08 donde el valor real es 4.37.
//
// QR nunca forma X'X, así que trabaja con el condicionamiento de X y no con su
// cuadrado. Hoy lo usa únicamente computeADF; `runOLS` sigue con su camino de
// siempre para no cambiar el estimador que usan todas las regresiones.

export interface QrOlsFit {
  /** Incluye el intercepto primero: [intercepto, β₁, …, βₖ]. */
  coefficients: number[];
  standardErrors: number[];
  tStats: number[];
  residuals: number[];
  residualDegreesOfFreedom: number;
}

const EPSILON = 1e-12;

/**
 * Ajusta y = α + Xβ + ε por QR y devuelve la inferencia clásica.
 *
 * Agrega la columna del intercepto por su cuenta, así que `X` trae solo las
 * regresoras y los índices del resultado quedan alineados con los de `runOLS`:
 * la posición 0 es el intercepto y la j es la j-ésima columna de `X`.
 *
 * Devuelve `null` cuando el diseño no tiene rango completo, en vez de tirar:
 * quien llama suele tener una salida (el ADF reintenta con menos rezagos).
 */
export function fitOlsQr(X: number[][], y: number[]): QrOlsFit | null {
  const m = X.length;
  if (m === 0 || y.length !== m) return null;
  const p = X[0].length + 1;
  if (m <= p) return null;

  // Copias de trabajo: Householder sobrescribe A y b en el lugar.
  const A: number[][] = X.map(row => [1, ...row]);
  const b: number[] = [...y];

  // ── Triangulación ────────────────────────────────────────────────────────
  for (let k = 0; k < p; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += A[i][k] * A[i][k];
    norm = Math.sqrt(norm);
    if (norm < EPSILON) return null; // columna nula ⇒ rango deficiente

    // El signo evita la cancelación catastrófica al restar en v[0].
    const alpha = A[k][k] >= 0 ? -norm : norm;
    const v: number[] = new Array(m - k);
    v[0] = A[k][k] - alpha;
    for (let i = k + 1; i < m; i++) v[i - k] = A[i][k];

    let vNorm2 = 0;
    for (let i = 0; i < v.length; i++) vNorm2 += v[i] * v[i];
    if (vNorm2 < EPSILON) {
      A[k][k] = alpha;
      continue;
    }

    for (let j = k; j < p; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i - k] * A[i][j];
      const factor = (2 * dot) / vNorm2;
      for (let i = k; i < m; i++) A[i][j] -= factor * v[i - k];
    }

    let dotB = 0;
    for (let i = k; i < m; i++) dotB += v[i - k] * b[i];
    const factorB = (2 * dotB) / vNorm2;
    for (let i = k; i < m; i++) b[i] -= factorB * v[i - k];

    A[k][k] = alpha;
  }

  // ── R y β ────────────────────────────────────────────────────────────────
  const R: number[][] = Array.from({ length: p }, (_, i) =>
    Array.from({ length: p }, (_, j) => (j >= i ? A[i][j] : 0))
  );
  for (let i = 0; i < p; i++) {
    if (Math.abs(R[i][i]) < EPSILON) return null; // rango deficiente
  }

  const beta = new Array<number>(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let sum = b[i];
    for (let j = i + 1; j < p; j++) sum -= R[i][j] * beta[j];
    beta[i] = sum / R[i][i];
  }

  // ── Inferencia ───────────────────────────────────────────────────────────
  // Los residuos se recalculan contra el diseño ORIGINAL, no contra la copia
  // que Householder fue sobrescribiendo.
  const residuals = y.map((yi, i) => {
    let fitted = beta[0];
    for (let j = 1; j < p; j++) fitted += beta[j] * X[i][j - 1];
    return yi - fitted;
  });

  const df = m - p;
  let rss = 0;
  for (const r of residuals) rss += r * r;
  const sigma2 = rss / df;

  // X = QR ⇒ X'X = R'R ⇒ (X'X)⁻¹ = R⁻¹R⁻ᵀ, así que el elemento j de la
  // diagonal es la norma al cuadrado de la fila j de R⁻¹. Nunca se forma X'X.
  const rInv: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  for (let col = 0; col < p; col++) {
    for (let i = col; i >= 0; i--) {
      let sum = i === col ? 1 : 0;
      for (let j = i + 1; j <= col; j++) sum -= R[i][j] * rInv[j][col];
      rInv[i][col] = sum / R[i][i];
    }
  }

  const standardErrors = new Array<number>(p);
  const tStats = new Array<number>(p);
  for (let i = 0; i < p; i++) {
    let rowNorm2 = 0;
    for (let j = i; j < p; j++) rowNorm2 += rInv[i][j] * rInv[i][j];
    standardErrors[i] = Math.sqrt(Math.max(0, sigma2 * rowNorm2));
    tStats[i] = standardErrors[i] > EPSILON ? beta[i] / standardErrors[i] : Infinity;
  }

  return {
    coefficients: beta,
    standardErrors,
    tStats,
    residuals,
    residualDegreesOfFreedom: df,
  };
}
