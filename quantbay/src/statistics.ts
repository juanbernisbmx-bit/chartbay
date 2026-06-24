// Statistical utility functions — Quant Bay Phase 2

function gammaLn(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  const tmp = x + 5.5;
  const base = -tmp + (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const ci of c) ser += ci / ++y;
  return base + Math.log(2.5066282746310005 * ser / x);
}

function betaLn(a: number, b: number): number {
  return gammaLn(a) + gammaLn(b) - gammaLn(a + b);
}

function betaIncCF(x: number, a: number, b: number): number {
  const EPS = 3e-7, FPMIN = 1e-30;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1.0, d = 1.0 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1.0 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1.0 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1.0 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1.0 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1.0 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1.0) < EPS) break;
  }
  return h;
}

export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lb = betaLn(a, b);
  if (x < (a + 1) / (a + b + 2)) {
    return Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lb) / a * betaIncCF(x, a, b);
  }
  return 1 - Math.exp(b * Math.log(1 - x) + a * Math.log(x) - lb) / b * betaIncCF(1 - x, b, a);
}

// Two-tailed p-value from t-distribution with `df` degrees of freedom
export function tDistPValue(t: number, df: number): number {
  if (!isFinite(t) || df <= 0) return 0;
  return betaInc(df / (df + t * t), df / 2, 0.5);
}

// Pearson correlation matrix; columns[i] is the i-th variable's observations
export function pearsonMatrix(columns: number[][]): number[][] {
  const k = columns.length;
  if (k === 0) return [];
  const n = columns[0].length;
  const means = columns.map(col => col.reduce((s, v) => s + v, 0) / n);
  const devs = columns.map((col, i) => col.map(v => v - means[i]));
  const corr: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let j = i; j < k; j++) {
      let num = 0, di2 = 0, dj2 = 0;
      for (let r = 0; r < n; r++) {
        num += devs[i][r] * devs[j][r];
        di2 += devs[i][r] ** 2;
        dj2 += devs[j][r] ** 2;
      }
      const denom = Math.sqrt(di2 * dj2);
      corr[i][j] = corr[j][i] = denom === 0 ? (i === j ? 1 : 0) : num / denom;
    }
  }
  return corr;
}
