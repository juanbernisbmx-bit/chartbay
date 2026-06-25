(function(){
'use strict';
// ─── Quant Bay bundle (auto-compiled) ────────────────────────────────────────
const __modules = {};
function require(id){
  if(__modules[id]) return __modules[id].exports;
  throw new Error('Module not found: '+id);
}

// ═══ statistics.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
// Statistical utility functions — Quant Bay Phase 2
exports.betaInc = betaInc;
exports.tDistPValue = tDistPValue;
exports.fDistPValue = fDistPValue;
exports.tQuantile = tQuantile;
exports.pearsonMatrix = pearsonMatrix;
function gammaLn(x) {
    const c = [
        76.18009172947146, -86.50532032941677, 24.01409824083091,
        -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
    ];
    let y = x;
    const tmp = x + 5.5;
    const base = -tmp + (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const ci of c)
        ser += ci / ++y;
    return base + Math.log(2.5066282746310005 * ser / x);
}
function betaLn(a, b) {
    return gammaLn(a) + gammaLn(b) - gammaLn(a + b);
}
function betaIncCF(x, a, b) {
    const EPS = 1e-10, FPMIN = 1e-30;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1.0, d = 1.0 - qab * x / qap;
    if (Math.abs(d) < FPMIN)
        d = FPMIN;
    d = 1.0 / d;
    let h = d;
    for (let m = 1; m <= 200; m++) {
        const m2 = 2 * m;
        let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if (Math.abs(d) < FPMIN)
            d = FPMIN;
        c = 1.0 + aa / c;
        if (Math.abs(c) < FPMIN)
            c = FPMIN;
        d = 1.0 / d;
        h *= d * c;
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if (Math.abs(d) < FPMIN)
            d = FPMIN;
        c = 1.0 + aa / c;
        if (Math.abs(c) < FPMIN)
            c = FPMIN;
        d = 1.0 / d;
        const del = d * c;
        h *= del;
        if (Math.abs(del - 1.0) < EPS)
            break;
    }
    return h;
}
function betaInc(x, a, b) {
    if (x <= 0)
        return 0;
    if (x >= 1)
        return 1;
    const lb = betaLn(a, b);
    if (x < (a + 1) / (a + b + 2)) {
        return Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lb) / a * betaIncCF(x, a, b);
    }
    return 1 - Math.exp(b * Math.log(1 - x) + a * Math.log(x) - lb) / b * betaIncCF(1 - x, b, a);
}
// Two-tailed p-value from t-distribution with `df` degrees of freedom
function tDistPValue(t, df) {
    if (!isFinite(t) || df <= 0)
        return 0;
    return betaInc(1 / (1 + t * t / df), df / 2, 0.5); // 1/(1+t²/df) avoids cancellation for large df
}
// Upper-tail p-value from F-distribution: P(F > f) with df1 numerator, df2 denominator df
function fDistPValue(f, df1, df2) {
    if (df1 <= 0 || df2 <= 0)
        return 1;
    if (!isFinite(f))
        return f > 0 ? 0 : 1;
    if (f <= 0)
        return 1;
    return betaInc(df2 / (df2 + df1 * f), df2 / 2, df1 / 2);
}
// Critical t-value via bisection: tDistPValue(result, df) ≈ alpha (two-tailed)
function tQuantile(alpha, df) {
    if (df <= 0)
        return Infinity;
    let lo = 0, hi = 200;
    for (let i = 0; i < 64; i++) {
        const mid = (lo + hi) / 2;
        if (tDistPValue(mid, df) > alpha)
            lo = mid;
        else
            hi = mid;
    }
    return (lo + hi) / 2;
}
// Pearson correlation matrix; columns[i] is the i-th variable's observations
function pearsonMatrix(columns) {
    const k = columns.length;
    if (k === 0)
        return [];
    const n = columns[0].length;
    const means = columns.map(col => col.reduce((s, v) => s + v, 0) / n);
    const devs = columns.map((col, i) => col.map(v => v - means[i]));
    const corr = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < k; i++) {
        for (let j = i; j < k; j++) {
            let num = 0, di2 = 0, dj2 = 0;
            for (let r = 0; r < n; r++) {
                num += devs[i][r] * devs[j][r];
                di2 += devs[i][r] ** 2;
                dj2 += devs[j][r] ** 2;
            }
            const denom = Math.sqrt(di2) * Math.sqrt(dj2); // separate sqrts avoid overflow for large values
            corr[i][j] = corr[j][i] = denom === 0 ? (i === j ? 1 : 0) : num / denom;
        }
    }
    return corr;
}

  __modules['statistics'] = module;
})();

// ═══ regression.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
exports.transpose = transpose;
exports.matMul = matMul;
exports.matVecMul = matVecMul;
exports.dotProduct = dotProduct;
exports.mean = mean;
exports.matInv = matInv;
exports.runOLS = runOLS;
exports.computeVIF = computeVIF;
const statistics_1 = __modules['statistics'].exports;
function transpose(A) {
    const rows = A.length, cols = A[0].length;
    return Array.from({ length: cols }, (_, j) => Array.from({ length: rows }, (_, i) => A[i][j]));
}
function matMul(A, B) {
    const m = A.length, n = B[0].length;
    return Array.from({ length: m }, (_, i) => Array.from({ length: n }, (_, j) => A[i].reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
}
function matVecMul(A, v) {
    return A.map(row => dotProduct(row, v));
}
function dotProduct(a, b) {
    return a.reduce((s, ai, i) => s + ai * b[i], 0);
}
function mean(arr) {
    return arr.reduce((s, x) => s + x, 0) / arr.length;
}
function matInv(A) {
    const n = A.length;
    const aug = A.map((row, i) => [
        ...row,
        ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    ]);
    for (let col = 0; col < n; col++) {
        let maxRow = col;
        for (let r = col + 1; r < n; r++) {
            if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col]))
                maxRow = r;
        }
        [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
        const pivot = aug[col][col];
        if (Math.abs(pivot) < 1e-12) {
            throw new Error('Matriz singular: las variables pueden ser colineales.');
        }
        for (let j = 0; j < 2 * n; j++)
            aug[col][j] /= pivot;
        for (let r = 0; r < n; r++) {
            if (r !== col) {
                const f = aug[r][col];
                for (let j = 0; j < 2 * n; j++)
                    aug[r][j] -= f * aug[col][j];
            }
        }
    }
    return aug.map(row => row.slice(n));
}
function runOLS(input) {
    const { X, y, featureNames, yName } = input;
    const n = y.length;
    const k = X[0].length;
    if (n < k + 2) {
        throw new Error(`Se necesitan al menos ${k + 2} observaciones para ${k} variable(s).`);
    }
    const Xd = X.map(row => [1, ...row]);
    const Xt = transpose(Xd);
    const XtX = matMul(Xt, Xd);
    const XtXinv = matInv(XtX);
    const Xty = matVecMul(Xt, y);
    const beta = matVecMul(XtXinv, Xty);
    const intercept = beta[0];
    const coefficients = beta.slice(1);
    const predictions = Xd.map(row => dotProduct(beta, row));
    const residuals = y.map((yi, i) => yi - predictions[i]);
    const yMean = mean(y);
    const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
    const ssRes = residuals.reduce((s, r) => s + r ** 2, 0);
    const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
    const df = n - k - 1;
    const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / df;
    const sigma2 = df > 0 ? ssRes / df : 0;
    // Standard errors: SE(βᵢ) = sqrt(σ² * (X'X)⁻¹ᵢᵢ)
    const stdErrors = XtXinv.map((row, i) => Math.sqrt(Math.max(0, sigma2 * row[i])));
    const tStats = beta.map((b, i) => stdErrors[i] > 1e-15 ? b / stdErrors[i] : Infinity);
    const pValues = tStats.map(t => (0, statistics_1.tDistPValue)(t, df));
    // F-statistic: (R²/k) / ((1-R²)/df) — tests H₀: all slopes = 0
    const fStat = k > 0 && df > 0 ? (rSquared / k) / ((1 - rSquared) / df) : 0;
    const fPValue = (0, statistics_1.fDistPValue)(fStat, k, df);
    // 95% confidence intervals: β ± t(0.025, df) * SE
    const tCrit = (0, statistics_1.tQuantile)(0.05, df);
    const ci95 = beta.map((b, i) => [b - tCrit * stdErrors[i], b + tCrit * stdErrors[i]]);
    const terms = coefficients
        .map((c, i) => `${c >= 0 ? ' + ' : ' - '}${Math.abs(c).toFixed(4)}·${featureNames[i]}`)
        .join('');
    const equation = `${yName} = ${intercept.toFixed(4)}${terms}`;
    return {
        coefficients,
        intercept,
        rSquared,
        adjustedRSquared,
        predictions,
        residuals,
        equation,
        featureNames,
        yName,
        nObs: n,
        nFeatures: k,
        stdErrors,
        tStats,
        pValues,
        ci95,
        df,
        sigma2,
        fStat,
        fPValue,
    };
}
// Variance Inflation Factor for each predictor in X (n×k matrix)
function computeVIF(X) {
    const k = X[0]?.length ?? 0;
    if (k <= 1)
        return new Array(k).fill(1);
    return Array.from({ length: k }, (_, j) => {
        const yVIF = X.map(row => row[j]);
        const xOther = X.map(row => row.filter((_, c) => c !== j));
        try {
            const res = runOLS({
                X: xOther,
                y: yVIF,
                featureNames: xOther[0].map((_, i) => `x${i}`),
                yName: `x${j}`,
            });
            const r2 = Math.max(0, res.rSquared);
            if (r2 >= 1 - 1e-10)
                return Infinity;
            return 1 / (1 - r2);
        }
        catch {
            return Infinity;
        }
    });
}

  __modules['regression'] = module;
})();

// ═══ csvParser.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
exports.parseCSVFile = parseCSVFile;
exports.extractColumn = extractColumn;
exports.extractMatrix = extractMatrix;
exports.getValidRows = getValidRows;
function parseCSVFile(file) {
    if (typeof Papa === 'undefined') {
        return Promise.reject(new Error('PapaParse no cargado'));
    }
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: true,
            skipEmptyLines: true,
            dynamicTyping: true,
            complete(result) {
                const headers = result.meta.fields ?? [];
                const rows = result.data;
                const numericColumns = headers.filter(h => rows.length > 0 &&
                    rows.every(row => {
                        const v = row[h];
                        return v !== null && v !== '' && !isNaN(Number(v));
                    }));
                resolve({ headers, rows, numericColumns });
            },
            error(err) {
                reject(new Error(String(err)));
            },
        });
    });
}
function isValidNumeric(raw) {
    if (raw === null || raw === undefined || raw === '')
        return false;
    const v = Number(raw);
    return !isNaN(v) && isFinite(v);
}
function extractColumn(rows, column) {
    return rows.reduce((acc, row) => {
        const raw = row[column];
        if (isValidNumeric(raw))
            acc.push(Number(raw));
        return acc;
    }, []);
}
function extractMatrix(rows, columns) {
    const X = [];
    const validIndices = [];
    rows.forEach((row, i) => {
        if (columns.every(col => isValidNumeric(row[col]))) {
            X.push(columns.map(col => Number(row[col])));
            validIndices.push(i);
        }
    });
    return { X, validIndices };
}
function getValidRows(rows, yName, xNames) {
    const allCols = [yName, ...xNames];
    const valid = rows.filter(row => allCols.every(col => isValidNumeric(row[col])));
    return {
        X: valid.map(row => xNames.map(col => Number(row[col]))),
        y: valid.map(row => Number(row[yName])),
        dropped: rows.length - valid.length,
    };
}

  __modules['csvParser'] = module;
})();

// ═══ interpretation.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
exports.interpret = interpret;
function interpret(result) {
    const { rSquared, adjustedRSquared, featureNames, coefficients, yName, nObs, pValues } = result;
    const r2pct = (rSquared * 100).toFixed(1);
    const ar2pct = (adjustedRSquared * 100).toFixed(1);
    const quality = rSquared >= 0.8 ? 'muy bueno' : rSquared >= 0.5 ? 'moderado' : 'débil';
    const sigCount = pValues.slice(1).filter(p => p < 0.05).length;
    const totalCoef = featureNames.length;
    const lines = [
        `El modelo explica el ${r2pct}% de la variación en "${yName}" (R² = ${rSquared.toFixed(4)}).`,
        `El ajuste es ${quality} (R² ajustado = ${ar2pct}%, n = ${nObs} observaciones).`,
        '',
        sigCount === totalCoef
            ? 'Significancia: todas las variables son estadísticamente significativas (p < 0.05).'
            : sigCount === 0
                ? 'Significancia: ninguna variable resulta estadísticamente significativa (p < 0.05). El modelo puede estar mal especificado o los datos ser insuficientes.'
                : `Significancia: ${sigCount} de ${totalCoef} variable(s) son estadísticamente significativas (p < 0.05).`,
        '',
        'Lectura de coeficientes (manteniendo el resto constante):',
        ...featureNames.map((name, i) => {
            const c = coefficients[i];
            const dir = c > 0 ? 'aumenta' : 'disminuye';
            const pSig = pValues[i + 1] < 0.05 ? '' : ' (no significativo estadísticamente)';
            return `  • Por cada unidad de aumento en "${name}", "${yName}" ${dir} en ${Math.abs(c).toFixed(4)} unidades${pSig}.`;
        }),
        '',
        rSquared < 0.3
            ? '⚠ El R² bajo sugiere que las variables seleccionadas explican poca variación. Considerá agregar más predictores o revisar los datos.'
            : rSquared > 0.95
                ? '⚠ Un R² muy alto puede indicar sobreajuste o multicolinealidad. Verificá que las variables sean independientes entre sí.'
                : '',
        '',
        'Nota: OLS asume linealidad, homocedasticidad e independencia de los residuos. Verificá estos supuestos antes de usar el modelo.',
    ];
    return lines
        .filter((line, i, a) => !(line === '' && (i === 0 || a[i - 1] === '')))
        .join('\n');
}

  __modules['interpretation'] = module;
})();

// ═══ utils/format.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
exports.escapeHtml = void 0;
exports.significanceBadge = significanceBadge;
exports.significanceLabel = significanceLabel;
exports.correlationClass = correlationClass;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
exports.escapeHtml = escapeHtml;
function significanceBadge(pValue) {
    if (pValue < 0.01)
        return '<span class="sig-badge sig-h">*** p&lt;0.01</span>';
    if (pValue < 0.05)
        return '<span class="sig-badge sig-m">** p&lt;0.05</span>';
    if (pValue < 0.10)
        return '<span class="sig-badge sig-l">* p&lt;0.10</span>';
    return '<span class="sig-badge sig-n">n.s.</span>';
}
function significanceLabel(pValue) {
    if (pValue < 0.01)
        return '***';
    if (pValue < 0.05)
        return '**';
    if (pValue < 0.10)
        return '*';
    return 'n.s.';
}
function correlationClass(value, isDiagonal) {
    if (isDiagonal)
        return 'corr-diag';
    if (value >= 0.7)
        return 'corr-sp';
    if (value <= -0.7)
        return 'corr-sn';
    if (value >= 0.3)
        return 'corr-mp';
    if (value <= -0.3)
        return 'corr-mn';
    return 'corr-w';
}

  __modules['utils_format'] = module;
})();

// ═══ services/analysisService.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
exports.getCompleteNumericColumns = getCompleteNumericColumns;
exports.isBinaryTarget = isBinaryTarget;
exports.detectLeakage = detectLeakage;
exports.runLogistic = runLogistic;
exports.runQuantAnalysis = runQuantAnalysis;
const csvParser_1 = __modules['csvParser'].exports;
const regression_1 = __modules['regression'].exports;
const statistics_1 = __modules['statistics'].exports;
function getCompleteNumericColumns(rows, colNames) {
    const valid = rows.filter(row => colNames.every(c => {
        const raw = row[c];
        if (raw === null || raw === undefined || raw === '')
            return false;
        const v = Number(raw);
        return !isNaN(v) && isFinite(v);
    }));
    return colNames.map(col => valid.map(row => Number(row[col])));
}
const LEAK_THRESHOLD = 0.95;
function mean(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function dot(a, b) {
    return a.reduce((sum, value, index) => sum + value * b[index], 0);
}
function sigmoid(z) {
    if (z > 500)
        return 1;
    if (z < -500)
        return 0;
    return 1 / (1 + Math.exp(-z));
}
function isBinaryTarget(y) {
    return new Set(y).size === 2;
}
function detectLeakage(X, y, xNames, threshold = LEAK_THRESHOLD) {
    const yMean = mean(y);
    const yDev = y.map(value => value - yMean);
    const yVar = yDev.reduce((sum, value) => sum + value * value, 0);
    return xNames
        .map((name, index) => {
        const xCol = X.map(row => row[index]);
        const xMean = mean(xCol);
        const xDev = xCol.map(value => value - xMean);
        const numerator = xDev.reduce((sum, value, rowIndex) => sum + value * yDev[rowIndex], 0);
        const denominator = Math.sqrt(xDev.reduce((sum, value) => sum + value * value, 0) * yVar);
        const r = denominator === 0 ? 0 : numerator / denominator;
        return { name, r, abs: Math.abs(r) };
    })
        .filter(signal => signal.abs >= threshold);
}
function runLogistic({ X, y, featureNames, yName, maxIter = 1500, lr = 0.05, }) {
    const n = y.length;
    const yVals = [...new Set(y)].sort((a, b) => a - b);
    const yBin = y.map(value => (value === yVals[1] ? 1 : 0));
    const Xd = X.map(row => [1, ...row]);
    const p = Xd[0].length;
    let beta = new Array(p).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
        const probs = Xd.map(row => sigmoid(dot(beta, row)));
        const errors = probs.map((prob, index) => prob - yBin[index]);
        const gradient = Array.from({ length: p }, (_, col) => Xd.reduce((sum, row, rowIndex) => sum + row[col] * errors[rowIndex], 0) / n);
        beta = beta.map((value, index) => value - lr * gradient[index]);
    }
    const probs = Xd.map(row => sigmoid(dot(beta, row)));
    const eps = 1e-15;
    const llModel = probs.reduce((sum, prob, index) => sum +
        yBin[index] * Math.log(Math.max(eps, prob)) +
        (1 - yBin[index]) * Math.log(Math.max(eps, 1 - prob)), 0);
    const pMean = mean(yBin);
    const llNull = n *
        (pMean * Math.log(Math.max(eps, pMean)) +
            (1 - pMean) * Math.log(Math.max(eps, 1 - pMean)));
    const predicted = probs.map(prob => (prob >= 0.5 ? 1 : 0));
    return {
        intercept: beta[0],
        coefficients: beta.slice(1),
        oddsRatios: beta.slice(1).map(coef => Math.exp(coef)),
        mcFaddenR2: llNull !== 0 ? Math.max(0, 1 - llModel / llNull) : 0,
        accuracy: predicted.filter((prediction, index) => prediction === yBin[index]).length / n,
        llModel,
        llNull,
        featureNames,
        yName,
        yVals,
        n,
    };
}
function runQuantAnalysis(csvData, yName, xNames) {
    const { X, y, dropped } = (0, csvParser_1.getValidRows)(csvData.rows, yName, xNames);
    if (y.length < xNames.length + 2) {
        throw new Error(`Observaciones insuficientes (${y.length}) para ${xNames.length} variable(s).`);
    }
    const result = (0, regression_1.runOLS)({ X, y, featureNames: xNames, yName });
    const allColData = getCompleteNumericColumns(csvData.rows, csvData.numericColumns);
    const binary = isBinaryTarget(y);
    const leaks = detectLeakage(X, y, xNames);
    let logitResult = null;
    if (binary) {
        try {
            logitResult = runLogistic({ X, y, featureNames: xNames, yName });
        }
        catch {
            logitResult = null;
        }
    }
    return {
        result,
        dropped,
        corrMatrix: (0, statistics_1.pearsonMatrix)(allColData),
        corrColumns: csvData.numericColumns,
        vifValues: (0, regression_1.computeVIF)(X),
        binary,
        leaks,
        logitResult,
    };
}

  __modules['services_analysisService'] = module;
})();

// ═══ services/autoRepair.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
exports.autoRepairAndAnalyze = autoRepairAndAnalyze;
/**
 * Auto-repair module for Quant Bay.
 * Detects and fixes: perfect collinearity, singular matrix,
 * high VIF (multicollinearity), and insufficient observations.
 * Returns a structured log of every action taken and its statistical rationale.
 */
const csvParser_1 = __modules['csvParser'].exports;
const regression_1 = __modules['regression'].exports;
const statistics_1 = __modules['statistics'].exports;
const analysisService_1 = __modules['services_analysisService'].exports;
// ── Internal helpers ──────────────────────────────────────────────────────────
function pearsonR(a, b) {
    const n = a.length;
    const ma = a.reduce((s, v) => s + v, 0) / n;
    const mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da2 = 0, db2 = 0;
    for (let i = 0; i < n; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da2 += (a[i] - ma) ** 2;
        db2 += (b[i] - mb) ** 2;
    }
    const denom = Math.sqrt(da2 * db2);
    return denom === 0 ? 0 : num / denom;
}
// ── Main function ─────────────────────────────────────────────────────────────
function autoRepairAndAnalyze(csvData, yName, xNamesInput) {
    const actions = [];
    let xNames = [...xNamesInput];
    function getData() {
        return (0, csvParser_1.getValidRows)(csvData.rows, yName, xNames);
    }
    // ── STEP 1: Remove perfectly collinear X pairs (|r| ≥ 0.9999) ────────────
    // These would make XtX singular before we even try OLS.
    // We keep the variable with higher |r| with Y (more informative).
    let collinearClean = false;
    while (!collinearClean && xNames.length > 1) {
        const { X, y } = getData();
        const cols = xNames.map((_, j) => X.map(row => row[j]));
        let found = false;
        outer: for (let i = 0; i < cols.length; i++) {
            for (let j = i + 1; j < cols.length; j++) {
                const r = Math.abs(pearsonR(cols[i], cols[j]));
                if (r < 0.9999)
                    continue;
                const ri = Math.abs(pearsonR(cols[i], y));
                const rj = Math.abs(pearsonR(cols[j], y));
                const toRemove = ri <= rj ? i : j;
                const kept = toRemove === i ? j : i;
                const name = xNames[toRemove];
                actions.push({
                    removed: name,
                    reason: 'perfect_collinearity',
                    valueBefore: r,
                    detail: `"${name}" tiene correlación de ${r.toFixed(4)} con "${xNames[kept]}" — ` +
                        `prácticamente perfecta (umbral: 0.9999). Se eliminó porque su correlación ` +
                        `con "${yName}" (r = ${ri.toFixed(4)}) era menor que la de ` +
                        `"${xNames[kept]}" (r = ${rj.toFixed(4)}). Mantener ambas hace ` +
                        `la matriz X'X singular, imposibilitando la inversión necesaria para OLS.`,
                });
                xNames.splice(toRemove, 1);
                found = true;
                break outer;
            }
        }
        if (!found)
            collinearClean = true;
    }
    // ── STEP 2: Try OLS; if singular, remove most redundant X and retry ───────
    let olsOk = false;
    const maxAttempts = xNamesInput.length + 1;
    for (let attempt = 0; attempt < maxAttempts && !olsOk; attempt++) {
        if (xNames.length === 0)
            break;
        const { X, y } = getData();
        // Not enough observations
        if (y.length < xNames.length + 2) {
            if (xNames.length === 1)
                break;
            const cols = xNames.map((_, j) => X.map(row => row[j]));
            let worstIdx = 0, worstCorr = Infinity;
            for (let i = 0; i < cols.length; i++) {
                const r = Math.abs(pearsonR(cols[i], y));
                if (r < worstCorr) {
                    worstCorr = r;
                    worstIdx = i;
                }
            }
            const name = xNames[worstIdx];
            actions.push({
                removed: name,
                reason: 'insufficient_obs',
                detail: `Solo hay ${y.length} observación(es) válidas para ${xNames.length} predictora(s) ` +
                    `(se necesitan ≥ ${xNames.length + 2} para tener grados de libertad). ` +
                    `Se eliminó "${name}" (la menos correlacionada con "${yName}", ` +
                    `r = ${worstCorr.toFixed(4)}) para recuperar grados de libertad residual.`,
            });
            xNames.splice(worstIdx, 1);
            continue;
        }
        try {
            (0, regression_1.runOLS)({ X, y, featureNames: xNames, yName });
            olsOk = true;
        }
        catch (err) {
            const msg = String(err.message ?? '');
            const isSingular = msg.toLowerCase().includes('singular') ||
                msg.toLowerCase().includes('colineal');
            if (!isSingular || xNames.length === 1)
                throw err;
            // Remove the X with the highest average |r| with the other Xs (most redundant)
            const cols = xNames.map((_, j) => X.map(row => row[j]));
            let worstIdx = 0, worstAvg = -1;
            for (let i = 0; i < cols.length; i++) {
                let sum = 0;
                for (let j = 0; j < cols.length; j++) {
                    if (j !== i)
                        sum += Math.abs(pearsonR(cols[i], cols[j]));
                }
                const avg = sum / (cols.length - 1);
                if (avg > worstAvg) {
                    worstAvg = avg;
                    worstIdx = i;
                }
            }
            const name = xNames[worstIdx];
            actions.push({
                removed: name,
                reason: 'singular_matrix',
                valueBefore: worstAvg,
                detail: `La matriz X'X resultó singular: al menos dos variables son linealmente ` +
                    `dependientes. Se eliminó "${name}" porque tiene la correlación promedio más ` +
                    `alta con las demás predictoras (r̄ = ${worstAvg.toFixed(4)}), ` +
                    `lo que indica que es la más redundante del conjunto.`,
            });
            xNames.splice(worstIdx, 1);
        }
    }
    if (xNames.length === 0) {
        throw new Error('No fue posible construir un modelo válido con las variables seleccionadas.');
    }
    // ── STEP 3: VIF — iteratively remove the highest-VIF variable until VIF ≤ 10
    // Rationale: VIF = 1/(1 - R²_j) where R²_j is from regressing X_j on the
    // other Xs. VIF > 10 → R²_j > 0.90 → the variable shares >90% of its
    // variance with others, inflating standard errors and making coefficients
    // unstable and difficult to interpret.
    const VIF_THRESHOLD = 10;
    let vifClean = false;
    while (!vifClean && xNames.length > 1) {
        const { X, y } = getData();
        const vifs = (0, regression_1.computeVIF)(X);
        const maxVif = Math.max(...vifs);
        if (maxVif <= VIF_THRESHOLD) {
            vifClean = true;
            break;
        }
        const worstIdx = vifs.indexOf(maxVif);
        const name = xNames[worstIdx];
        const vifStr = isFinite(maxVif) ? maxVif.toFixed(1) : '>999';
        actions.push({
            removed: name,
            reason: 'high_vif',
            valueBefore: maxVif,
            detail: `"${name}" tiene VIF = ${vifStr} (umbral: ${VIF_THRESHOLD}). ` +
                `El VIF mide cuánto se inflaron los errores estándar de este coeficiente por ` +
                `multicolinealidad. Un VIF > 10 indica que esta variable comparte más del 90 % ` +
                `de su varianza con las demás predictoras, haciendo sus coeficientes inestables ` +
                `e interpretaciones poco confiables. Se eliminó y se re-estimó el modelo.`,
        });
        xNames.splice(worstIdx, 1);
        // Re-run to confirm the reduced model is valid
        try {
            const { X: Xr, y: yr } = getData();
            (0, regression_1.runOLS)({ X: Xr, y: yr, featureNames: xNames, yName });
        }
        catch {
            break;
        }
    }
    // ── Final model ───────────────────────────────────────────────────────────
    const { X: Xf, y: yf, dropped } = getData();
    const finalResult = (0, regression_1.runOLS)({ X: Xf, y: yf, featureNames: xNames, yName });
    const allColData = (0, analysisService_1.getCompleteNumericColumns)(csvData.rows, csvData.numericColumns);
    const binary = (0, analysisService_1.isBinaryTarget)(yf);
    const leaks = (0, analysisService_1.detectLeakage)(Xf, yf, xNames);
    let logitResult = null;
    if (binary) {
        try {
            logitResult = (0, analysisService_1.runLogistic)({ X: Xf, y: yf, featureNames: xNames, yName });
        }
        catch { /* ignore */ }
    }
    return {
        result: finalResult,
        dropped,
        corrMatrix: (0, statistics_1.pearsonMatrix)(allColData),
        corrColumns: csvData.numericColumns,
        vifValues: (0, regression_1.computeVIF)(Xf),
        binary,
        leaks,
        logitResult,
        actions,
        originalXNames: xNamesInput,
        finalXNames: [...xNames],
        repaired: actions.length > 0,
    };
}

  __modules['services_autoRepair'] = module;
})();

// ═══ main.js ═══
(function(){
  const exports = {}; const module = {exports};
  "use strict";
const csvParser_1 = __modules['csvParser'].exports;
const interpretation_1 = __modules['interpretation'].exports;
const analysisService_1 = __modules['services_analysisService'].exports;
const autoRepair_1 = __modules['services_autoRepair'].exports;
const format_1 = __modules['utils_format'].exports;
let csvData = null;
let activeChart = null;
let residFittedChart = null;
let residHistChart = null;
let lastResult = null;
let lastCorr = null;
let lastCorrCols = null;
let lastVIF = null;
let lastLogit = null;
const $ = (id) => document.getElementById(id);
function showError(msg) {
    const el = $('qb-error');
    if (!el)
        return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
}
function setText(id, value) {
    const el = $(id);
    if (el)
        el.textContent = String(value);
}
function setEngineStatus(value) {
    setText('qb-status-engine', value);
}
function writeRunLog(lines) {
    const log = $('qb-runlog');
    if (!log)
        return;
    log.innerHTML = lines.map(line => `<div>${(0, format_1.escapeHtml)(line)}</div>`).join('');
}
async function technicalLoadSequence() {
    const steps = [
        'Parsing dataset...',
        'Cleaning missing values...',
        'Building design matrix...',
        'Estimating OLS coefficients...',
        'Computing diagnostics...',
    ];
    const emitted = [];
    setEngineStatus('RUNNING');
    for (const step of steps) {
        emitted.push(step);
        writeRunLog(emitted);
        await new Promise(resolve => setTimeout(resolve, 90));
    }
}
function chartTheme(title, xTitle, yTitle, legend = true) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                display: legend,
                labels: { color: '#9aa7b7', font: { family: 'Consolas, monospace', size: 10 }, boxWidth: 10 },
            },
            title: {
                display: true,
                text: title,
                color: '#d8e2ee',
                font: { family: 'Consolas, monospace', size: 11, weight: '600' },
            },
        },
        scales: {
            x: {
                title: { display: true, text: xTitle, color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
                ticks: { color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
                grid: { color: 'rgba(125,136,150,.14)', lineWidth: 1 },
                border: { color: '#202a36' },
            },
            y: {
                title: { display: true, text: yTitle, color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
                ticks: { color: '#7d8896', font: { family: 'Consolas, monospace', size: 10 } },
                grid: { color: 'rgba(125,136,150,.14)', lineWidth: 1 },
                border: { color: '#202a36' },
            },
        },
    };
}
// ── Upload ────────────────────────────────────────────────────────────────────
async function onFileChange(e) {
    const file = e.target.files?.[0];
    if (!file)
        return;
    showError('');
    const fn = $('qb-filename');
    if (fn)
        fn.textContent = file.name;
    setText('qb-status-dataset', file.name);
    setEngineStatus('PARSING');
    writeRunLog(['Mounting CSV in data hold...']);
    try {
        csvData = await (0, csvParser_1.parseCSVFile)(file);
        if (csvData.numericColumns.length < 2) {
            showError('El CSV necesita al menos 2 columnas numéricas.');
            return;
        }
        setText('qb-status-obs', csvData.rows.length);
        setText('qb-status-vars', csvData.numericColumns.length);
        setEngineStatus('READY');
        writeRunLog([
            `Dataset mounted: ${csvData.rows.length} observations`,
            `Numeric variables detected: ${csvData.numericColumns.length}`,
            'Regression engine ready.',
        ]);
        renderPreview(csvData);
        renderVarSelectors(csvData.numericColumns);
        const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results');
        if (preview)
            preview.style.display = '';
        if (vars)
            vars.style.display = '';
        if (results)
            results.style.display = 'none';
    }
    catch (err) {
        setEngineStatus('ERROR');
        showError(`Error al leer el archivo: ${err.message}`);
    }
}
// ── Preview ───────────────────────────────────────────────────────────────────
function renderPreview({ headers, rows, numericColumns }) {
    const preview = rows.slice(0, 6);
    const thead = `<tr>${headers.map(h => `<th>${(0, format_1.escapeHtml)(h)}</th>`).join('')}</tr>`;
    const tbody = preview
        .map(row => `<tr>${headers.map(h => `<td>${(0, format_1.escapeHtml)(row[h])}</td>`).join('')}</tr>`)
        .join('');
    const wrap = $('qb-table-wrap');
    if (!wrap)
        return;
    wrap.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
    </div>
    <p class="muted" style="font-size:11px;margin:4px 0 0">
      ${preview.length} de ${rows.length} filas · ${headers.length} columnas ·
      <strong>${numericColumns.length} numéricas</strong>
    </p>`;
}
// ── Variable selectors ────────────────────────────────────────────────────────
function renderVarSelectors(cols) {
    const yEl = $('qb-y');
    const xEl = $('qb-x-checks');
    if (yEl)
        yEl.innerHTML = cols.map(c => `<option value="${(0, format_1.escapeHtml)(c)}">${(0, format_1.escapeHtml)(c)}</option>`).join('');
    if (xEl)
        xEl.innerHTML = cols
            .map((c, i) => `<label class="qb-x-check"><input type="checkbox" class="qb-x-cb" value="${(0, format_1.escapeHtml)(c)}" ${i > 0 ? 'checked' : ''}> ${(0, format_1.escapeHtml)(c)}</label>`)
            .join('');
}
// ── Run regression ────────────────────────────────────────────────────────────
async function onRun() {
    if (!csvData)
        return;
    showError('');
    const yName = $('qb-y')?.value ?? '';
    const xNames = Array.from(document.querySelectorAll('.qb-x-cb:checked'))
        .map(cb => cb.value)
        .filter(v => v !== yName);
    if (xNames.length === 0) {
        showError('Seleccioná al menos una variable X distinta de Y.');
        return;
    }
    try {
        await technicalLoadSequence();
        const analysis = (0, analysisService_1.runQuantAnalysis)(csvData, yName, xNames);
        lastResult = analysis.result;
        lastCorr = analysis.corrMatrix;
        lastCorrCols = analysis.corrColumns;
        lastVIF = analysis.vifValues;
        lastLogit = analysis.logitResult;
        renderResults(analysis.result, analysis.dropped, analysis.corrMatrix, analysis.corrColumns, analysis.vifValues, {
            binary: analysis.binary,
            leaks: analysis.leaks,
            logitResult: analysis.logitResult,
        });
        setText('qb-status-obs', analysis.result.nObs);
        setEngineStatus('COMPLETE');
        writeRunLog([
            'Parsing dataset... OK',
            'Cleaning missing values... OK',
            'Building design matrix... OK',
            'Estimating OLS coefficients... OK',
            'Computing diagnostics... OK',
        ]);
        const res = $('qb-results');
        if (res) {
            res.style.display = '';
            res.scrollIntoView({ behavior: 'smooth' });
        }
    }
    catch (err) {
        setEngineStatus('ERROR');
        showError(`Error en la regresión: ${err.message}`);
    }
}
// ── Results ───────────────────────────────────────────────────────────────────
function renderResults(result, dropped, corrMatrix, corrCols, vifValues, checks = {}) {
    const { binary = false, leaks = [], logitResult = null } = checks;
    renderBinaryWarn(binary, result.yName);
    renderLeakageWarn(leaks);
    const eq = $('qb-equation');
    if (eq)
        eq.textContent = result.equation;
    renderCoefTable(result);
    renderStatsTable(result, dropped);
    renderLogistic(logitResult);
    renderChart(result);
    renderCorrMatrix(corrMatrix, corrCols);
    renderVIF(vifValues, result.featureNames);
    renderResidDiag(result);
    const interp = $('qb-interpretation');
    if (interp)
        interp.textContent = (0, interpretation_1.interpret)(result);
    const actual = result.predictions.map((p, i) => p + result.residuals[i]);
    const predTable = $('qb-pred-table');
    if (predTable)
        predTable.innerHTML = `
      <table class="ledger" style="margin-top:8px">
        <thead><tr><th>#</th><th>Real</th><th>Predicho</th><th>Residuo</th></tr></thead>
        <tbody>${result.predictions
            .map((p, i) => `<tr><td>${i + 1}</td><td>${actual[i].toFixed(4)}</td><td>${p.toFixed(4)}</td><td>${result.residuals[i].toFixed(4)}</td></tr>`)
            .join('')}</tbody>
      </table>`;
}
function renderBinaryWarn(isBinary, yName) {
    const el = $('qb-binary-warn');
    if (!el)
        return;
    if (!isBinary) {
        el.innerHTML = '';
        return;
    }
    el.innerHTML = `
    <div class="qb-warn-yellow">
      <p><strong>Binary dependent variable detected: ${(0, format_1.escapeHtml)(yName)}</strong></p>
      <p>OLS is being used as a linear probability model. Predictions can fall outside [0, 1], residual variance is not constant, and coefficients should be read in approximate percentage-point terms.</p>
      <p>Logistic regression output is shown below the OLS coefficient ledger for comparison.</p>
    </div>`;
}
function renderLeakageWarn(leaks) {
    const el = $('qb-leak-warn');
    if (!el)
        return;
    if (!leaks.length) {
        el.innerHTML = '';
        return;
    }
    const rows = leaks
        .map(leak => `<p><strong>${(0, format_1.escapeHtml)(leak.name)}</strong> correlates ${leak.r.toFixed(4)} with the target (|r| = ${leak.abs.toFixed(4)}). Review whether this regressor is derived from the response.</p>`)
        .join('');
    el.innerHTML = `
    <div class="qb-warn-red">
      <p><strong>Possible data leakage detected</strong></p>
      ${rows}
      <p>Threshold: |r| >= 0.95.</p>
    </div>`;
}
function renderLogistic(res) {
    const wrap = $('qb-logit-wrap');
    const content = $('qb-logit-content');
    if (!wrap || !content)
        return;
    if (!res) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';
    const f4 = (n) => (isFinite(n) ? n.toFixed(4) : '-');
    const rows = res.featureNames
        .map((name, index) => `<tr><td>${(0, format_1.escapeHtml)(name)}</td><td>${f4(res.coefficients[index])}</td><td>${f4(res.oddsRatios[index])}</td></tr>`)
        .join('');
    content.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger">
        <thead><tr><th>Variable</th><th>Logit coef.</th><th>Odds ratio</th></tr></thead>
        <tbody>
          <tr><td>Intercept</td><td>${f4(res.intercept)}</td><td>${f4(Math.exp(res.intercept))}</td></tr>
          ${rows}
        </tbody>
      </table>
    </div>
    <table class="ledger qb-compact-ledger">
      <thead><tr><th>Metric</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>McFadden pseudo R²</td><td>${res.mcFaddenR2.toFixed(4)}</td></tr>
        <tr><td>Model log-likelihood</td><td>${res.llModel.toFixed(4)}</td></tr>
        <tr><td>Null log-likelihood</td><td>${res.llNull.toFixed(4)}</td></tr>
        <tr><td>In-sample accuracy</td><td>${(res.accuracy * 100).toFixed(1)}%</td></tr>
        <tr><td>Observations</td><td>${res.n}</td></tr>
      </tbody>
    </table>`;
}
function renderCoefTable(result) {
    const body = $('qb-coef-body');
    if (!body)
        return;
    const fmt6 = (n) => (isFinite(n) ? n.toFixed(6) : '—');
    const fmt4 = (n) => (isFinite(n) ? n.toFixed(4) : '—');
    const fmtCI = ([lo, hi]) => `[${fmt4(lo)},&nbsp;${fmt4(hi)}]`;
    body.innerHTML = [
        `<tr>
      <td>Intercepto</td>
      <td>${fmt6(result.intercept)}</td>
      <td>${fmt6(result.stdErrors[0])}</td>
      <td>${fmt4(result.tStats[0])}</td>
      <td>${fmt4(result.pValues[0])}</td>
      <td style="white-space:nowrap">${fmtCI(result.ci95[0])}</td>
      <td>${(0, format_1.significanceBadge)(result.pValues[0])}</td>
    </tr>`,
        ...result.featureNames.map((n, i) => `<tr>
        <td>${(0, format_1.escapeHtml)(n)}</td>
        <td>${fmt6(result.coefficients[i])}</td>
        <td>${fmt6(result.stdErrors[i + 1])}</td>
        <td>${fmt4(result.tStats[i + 1])}</td>
        <td>${fmt4(result.pValues[i + 1])}</td>
        <td style="white-space:nowrap">${fmtCI(result.ci95[i + 1])}</td>
        <td>${(0, format_1.significanceBadge)(result.pValues[i + 1])}</td>
      </tr>`),
    ].join('');
}
function renderStatsTable(result, dropped) {
    const body = $('qb-stats-body');
    if (!body)
        return;
    const fmtF = (f) => !isFinite(f) ? '∞' : f.toFixed(4);
    body.innerHTML = `
    <tr><td>R²</td><td>${result.rSquared.toFixed(6)}</td></tr>
    <tr><td>R² ajustado</td><td>${result.adjustedRSquared.toFixed(6)}</td></tr>
    <tr><td>F-estadístico</td><td>${fmtF(result.fStat)}</td></tr>
    <tr><td>p(F)</td><td>${result.fPValue.toFixed(6)}</td></tr>
    <tr><td>Observaciones (n)</td><td>${result.nObs}</td></tr>
    <tr><td>Variables (k)</td><td>${result.nFeatures}</td></tr>
    <tr><td>Grados de libertad</td><td>${result.df}</td></tr>
    <tr><td>σ² (var. residual)</td><td>${result.sigma2.toFixed(6)}</td></tr>
    ${dropped > 0 ? `<tr><td>Filas omitidas (NA)</td><td>${dropped}</td></tr>` : ''}`;
}
function renderChart(result) {
    const canvas = $('qb-chart');
    if (activeChart) {
        activeChart.destroy();
        activeChart = null;
    }
    if (typeof Chart === 'undefined' || !canvas)
        return;
    const actual = result.predictions.map((p, i) => p + result.residuals[i]);
    const allV = [...actual, ...result.predictions];
    const minV = Math.min(...allV), maxV = Math.max(...allV);
    const pad = (maxV - minV) * 0.05 || 1;
    activeChart = new Chart(canvas, {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Observaciones',
                    data: actual.map((a, i) => ({ x: a, y: result.predictions[i] })),
                    backgroundColor: 'rgba(77, 227, 181, .58)',
                    borderColor: '#4de3b5',
                    pointRadius: 3,
                    pointHoverRadius: 5,
                },
                {
                    label: 'Ajuste perfecto (y = x)',
                    data: [{ x: minV - pad, y: minV - pad }, { x: maxV + pad, y: maxV + pad }],
                    type: 'line',
                    borderColor: '#f2c94c',
                    borderDash: [6, 4],
                    borderWidth: 1,
                    pointRadius: 0,
                    fill: false,
                },
            ],
        },
        options: chartTheme(`${result.yName}: actual vs predicted`, `Actual (${result.yName})`, `Predicted (${result.yName})`),
    });
}
// ── Correlation matrix ────────────────────────────────────────────────────────
function renderCorrMatrix(corrMatrix, colNames) {
    const wrap = $('qb-corr-wrap');
    if (!wrap || !corrMatrix || corrMatrix.length === 0)
        return;
    const k = colNames.length;
    const abbr = (n) => (n.length > 9 ? n.slice(0, 8) + '…' : n);
    let html = '<table class="ledger qb-corr-table"><thead><tr><th></th>';
    html += colNames.map(n => `<th title="${(0, format_1.escapeHtml)(n)}">${(0, format_1.escapeHtml)(abbr(n))}</th>`).join('');
    html += '</tr></thead><tbody>';
    for (let i = 0; i < k; i++) {
        html += `<tr><th title="${(0, format_1.escapeHtml)(colNames[i])}">${(0, format_1.escapeHtml)(abbr(colNames[i]))}</th>`;
        for (let j = 0; j < k; j++) {
            const r = corrMatrix[i][j];
            html += `<td class="${(0, format_1.correlationClass)(r, i === j)}">${r.toFixed(3)}</td>`;
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;
    const interpEl = $('qb-corr-interp');
    if (!interpEl)
        return;
    const lines = [];
    for (let i = 0; i < k; i++) {
        for (let j = i + 1; j < k; j++) {
            const r = corrMatrix[i][j];
            const abs = Math.abs(r);
            if (abs >= 0.7) {
                const dir = r > 0 ? 'positiva' : 'negativa';
                const str = abs >= 0.9 ? 'muy fuerte' : 'fuerte';
                lines.push(`"${colNames[i]}" y "${colNames[j]}" — correlación ${dir} ${str} (r = ${r.toFixed(3)}).`);
            }
        }
    }
    interpEl.textContent = lines.length > 0
        ? lines.join('\n')
        : 'No se detectan correlaciones fuertes (|r| ≥ 0.70) entre las variables.';
    interpEl.style.display = '';
}
// ── VIF ───────────────────────────────────────────────────────────────────────
function renderVIF(vifValues, xNames) {
    const wrap = $('qb-vif-wrap');
    const warnEl = $('qb-vif-warn');
    if (!wrap)
        return;
    if (!vifValues || vifValues.length === 0) {
        wrap.innerHTML = '<p class="muted" style="font-size:11px">VIF no disponible con un solo predictor.</p>';
        return;
    }
    const warnings = [];
    let html = '<table class="ledger"><thead><tr><th>Variable</th><th>VIF</th><th>Estado</th></tr></thead><tbody>';
    vifValues.forEach((v, i) => {
        const vStr = !isFinite(v) ? '&gt;999' : v.toFixed(2);
        let cls, label;
        if (v >= 10) {
            cls = 'qb-vif-high';
            label = '⚠ Severo';
            warnings.push(`"${xNames[i]}" (VIF ${!isFinite(v) ? '>999' : v.toFixed(1)}): multicolinealidad severa — los coeficientes pueden ser inestables.`);
        }
        else if (v >= 5) {
            cls = 'qb-vif-med';
            label = '△ Precaución';
        }
        else {
            cls = 'qb-vif-ok';
            label = '✓ Aceptable';
        }
        html += `<tr><td>${(0, format_1.escapeHtml)(xNames[i])}</td><td>${vStr}</td><td class="${cls}">${label}</td></tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
    if (warnEl) {
        warnEl.innerHTML = warnings.length > 0
            ? `<div class="qb-warn">${warnings.map(w => `<p>${(0, format_1.escapeHtml)(w)}</p>`).join('')}</div>`
            : '';
    }
}
// ── Residual diagnostics ──────────────────────────────────────────────────────
function renderResidDiag(result) {
    if (typeof Chart === 'undefined')
        return;
    const rfCanvas = $('qb-resid-fitted');
    if (rfCanvas) {
        if (residFittedChart) {
            residFittedChart.destroy();
            residFittedChart = null;
        }
        const minP = Math.min(...result.predictions);
        const maxP = Math.max(...result.predictions);
        residFittedChart = new Chart(rfCanvas, {
            type: 'scatter',
            data: {
                datasets: [
                    {
                        label: 'Residuos',
                        data: result.predictions.map((p, i) => ({ x: p, y: result.residuals[i] })),
                        backgroundColor: 'rgba(77, 227, 181, .52)',
                        borderColor: '#4de3b5',
                        pointRadius: 3,
                    },
                    {
                        label: 'y=0',
                        type: 'line',
                        data: [{ x: minP, y: 0 }, { x: maxP, y: 0 }],
                        borderColor: '#f2c94c',
                        borderDash: [5, 3],
                        borderWidth: 1,
                        pointRadius: 0,
                        fill: false,
                    },
                ],
            },
            options: chartTheme('residuals vs fitted', 'Fitted value', 'Residual', false),
        });
    }
    const histCanvas = $('qb-resid-hist');
    if (histCanvas) {
        if (residHistChart) {
            residHistChart.destroy();
            residHistChart = null;
        }
        const resids = result.residuals;
        const minR = Math.min(...resids), maxR = Math.max(...resids);
        const bins = Math.min(10, Math.max(3, Math.floor(Math.sqrt(resids.length))));
        const bw = (maxR - minR) / bins || 1;
        const counts = new Array(bins).fill(0);
        resids.forEach(r => { const idx = Math.min(Math.floor((r - minR) / bw), bins - 1); counts[idx]++; });
        const labels = Array.from({ length: bins }, (_, i) => (minR + (i + 0.5) * bw).toFixed(2));
        residHistChart = new Chart(histCanvas, {
            type: 'bar',
            data: { labels, datasets: [{ data: counts, backgroundColor: 'rgba(122, 167, 255, .42)', borderColor: '#7aa7ff', borderWidth: 1 }] },
            options: chartTheme('residual distribution', 'Residual', 'Frequency', false),
        });
    }
    const statsEl = $('qb-resid-stats');
    if (statsEl) {
        const n = result.residuals.length;
        const mn = result.residuals.reduce((s, r) => s + r, 0) / n;
        const sd = Math.sqrt(result.residuals.reduce((s, r) => s + (r - mn) ** 2, 0) / Math.max(1, n - 1));
        statsEl.innerHTML = `<p class="qb-resid-stat-line">Media de residuos: <strong>${mn.toFixed(6)}</strong> &nbsp;·&nbsp; Desv. estándar: <strong>${sd.toFixed(6)}</strong></p>`;
    }
}
// ── PDF Export ────────────────────────────────────────────────────────────────
function exportPDF() {
    const jspdfLib = window.jspdf;
    if (!jspdfLib?.jsPDF) {
        alert('jsPDF no disponible. Verificá que el CDN cargó.');
        return;
    }
    if (!lastResult) {
        alert('Primero ejecutá una regresión.');
        return;
    }
    const { jsPDF } = jspdfLib;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = 190;
    let y = 15;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(14);
    doc.text('Quant Bay — Análisis de Regresión OLS', 10, y);
    y += 7;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Generado por ChartBay · ' + new Date().toLocaleDateString('es-AR'), 10, y);
    y += 8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Ecuación estimada:', 10, y);
    y += 5;
    doc.setFont('courier', 'normal');
    doc.setFontSize(8);
    const eqLines = doc.splitTextToSize(lastResult.equation, W);
    doc.text(eqLines, 10, y);
    y += eqLines.length * 4 + 5;
    if (doc.autoTable) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('Coeficientes y Significancia', 10, y);
        y += 4;
        doc.autoTable({
            head: [['Variable', 'Coef.', 'Err. Est.', 't-stat', 'p-valor', 'IC 95%', 'Signif.']],
            body: [
                ['Intercepto', lastResult.intercept.toFixed(6), lastResult.stdErrors[0].toFixed(6),
                    isFinite(lastResult.tStats[0]) ? lastResult.tStats[0].toFixed(4) : '—',
                    lastResult.pValues[0].toFixed(4),
                    `[${lastResult.ci95[0][0].toFixed(4)}, ${lastResult.ci95[0][1].toFixed(4)}]`,
                    (0, format_1.significanceLabel)(lastResult.pValues[0])],
                ...lastResult.featureNames.map((n, i) => [n,
                    lastResult.coefficients[i].toFixed(6),
                    lastResult.stdErrors[i + 1].toFixed(6),
                    isFinite(lastResult.tStats[i + 1]) ? lastResult.tStats[i + 1].toFixed(4) : '—',
                    lastResult.pValues[i + 1].toFixed(4),
                    `[${lastResult.ci95[i + 1][0].toFixed(4)}, ${lastResult.ci95[i + 1][1].toFixed(4)}]`,
                    (0, format_1.significanceLabel)(lastResult.pValues[i + 1])]),
            ],
            startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
        });
        y = doc.lastAutoTable.finalY + 5;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('Estadísticos del Modelo', 10, y);
        y += 4;
        doc.autoTable({
            head: [['Indicador', 'Valor']],
            body: [
                ['R²', lastResult.rSquared.toFixed(6)],
                ['R² ajustado', lastResult.adjustedRSquared.toFixed(6)],
                ['F-estadístico', isFinite(lastResult.fStat) ? lastResult.fStat.toFixed(4) : '∞'],
                ['p(F)', lastResult.fPValue.toFixed(6)],
                ['n (observaciones)', String(lastResult.nObs)],
                ['k (variables)', String(lastResult.nFeatures)],
                ['Grados de libertad', String(lastResult.df)],
                ['σ² (varianza residual)', lastResult.sigma2.toFixed(6)],
            ],
            startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
        });
        y = doc.lastAutoTable.finalY + 5;
    }
    const chartCanvas = $('qb-chart');
    if (chartCanvas) {
        if (y > 220) {
            doc.addPage();
            y = 15;
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('Real vs. Predicho', 10, y);
        y += 4;
        try {
            doc.addImage(chartCanvas.toDataURL('image/png'), 'PNG', 10, y, W, 65);
            y += 69;
        }
        catch (_) { }
    }
    if (lastCorr && lastCorrCols && doc.autoTable) {
        if (y > 200) {
            doc.addPage();
            y = 15;
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('Matriz de Correlación de Pearson', 10, y);
        y += 4;
        doc.autoTable({
            head: [['', ...lastCorrCols]],
            body: lastCorr.map((row, i) => [lastCorrCols[i], ...row.map(v => v.toFixed(3))]),
            startY: y, styles: { fontSize: 7 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
        });
        y = doc.lastAutoTable.finalY + 5;
    }
    if (lastVIF && doc.autoTable) {
        if (y > 220) {
            doc.addPage();
            y = 15;
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('Diagnóstico de Multicolinealidad (VIF)', 10, y);
        y += 4;
        doc.autoTable({
            head: [['Variable', 'VIF', 'Estado']],
            body: lastVIF.map((v, i) => [
                lastResult.featureNames[i],
                !isFinite(v) ? '>999' : v.toFixed(2),
                v >= 10 ? 'Severo' : v >= 5 ? 'Precaución' : 'Aceptable',
            ]),
            startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
        });
        y = doc.lastAutoTable.finalY + 5;
    }
    const rfCanvas = $('qb-resid-fitted');
    const rhCanvas = $('qb-resid-hist');
    if (rfCanvas || rhCanvas) {
        if (y > 200) {
            doc.addPage();
            y = 15;
        }
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.text('Diagnósticos de Residuos', 10, y);
        y += 4;
        try {
            if (rfCanvas)
                doc.addImage(rfCanvas.toDataURL('image/png'), 'PNG', 10, y, 90, 55);
            if (rhCanvas)
                doc.addImage(rhCanvas.toDataURL('image/png'), 'PNG', 105, y, 90, 55);
            y += 59;
        }
        catch (_) { }
    }
    if (y > 230) {
        doc.addPage();
        y = 15;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text('Interpretación Automática', 10, y);
    y += 5;
    const interpEl = $('qb-interpretation');
    if (interpEl) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        const lines = doc.splitTextToSize(interpEl.textContent ?? '', W);
        doc.text(lines, 10, y);
    }
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7);
        doc.text('Análisis estadístico educativo · No constituye asesoramiento financiero.', 10, 290);
        doc.text(`Pág. ${i}/${pageCount}`, 185, 290);
    }
    doc.save('quantbay_regresion.pdf');
}
// ── Auto-repair log ───────────────────────────────────────────────────────────
const REASON_LABEL = {
    perfect_collinearity: 'COLINEALIDAD PERFECTA',
    singular_matrix: 'MATRIZ SINGULAR',
    high_vif: 'VIF ELEVADO',
    insufficient_obs: 'OBS. INSUFICIENTES',
};
function renderRepairLog(result) {
    const el = $('qb-repair-log');
    if (!el)
        return;
    if (!result.repaired) {
        el.innerHTML = '';
        el.style.display = 'none';
        return;
    }
    const removed = result.actions.map(a => `<code>${(0, format_1.escapeHtml)(a.removed)}</code>`).join(', ');
    const kept = result.finalXNames.map(n => `<code>${(0, format_1.escapeHtml)(n)}</code>`).join(', ');
    const steps = result.actions.map((a, i) => {
        const valStr = a.valueBefore !== undefined
            ? ` — valor detectado: <strong>${isFinite(a.valueBefore) ? a.valueBefore.toFixed(3) : '>999'}</strong>`
            : '';
        return `
      <div class="qb-repair-step">
        <span class="qb-repair-badge qb-repair-${a.reason}">${REASON_LABEL[a.reason] ?? a.reason}</span>
        <div class="qb-repair-body">
          <strong>Paso ${i + 1}:</strong> eliminada <code>${(0, format_1.escapeHtml)(a.removed)}</code>${valStr}<br>
          <span class="muted">${(0, format_1.escapeHtml)(a.detail)}</span>
        </div>
      </div>`;
    }).join('');
    el.innerHTML = `
    <div class="qb-repair-log">
      <div class="qb-panel-head">
        <p class="qb-subtitle">Auto-repair log</p>
        <span>MODEL DOCTOR · ${result.actions.length} FIX${result.actions.length !== 1 ? 'ES' : ''}</span>
      </div>
      <p class="qb-repair-summary">
        Se detectaron <strong>${result.actions.length}</strong> problema(s) y se corrigieron automáticamente.<br>
        Variables originales: ${result.originalXNames.map(n => `<code>${(0, format_1.escapeHtml)(n)}</code>`).join(', ')}<br>
        Variables eliminadas: ${removed}<br>
        Modelo final con: ${kept}
      </p>
      <div class="qb-repair-steps">${steps}</div>
    </div>`;
    el.style.display = '';
}
// ── Auto-run handler ──────────────────────────────────────────────────────────
function onAutoRun() {
    if (!csvData)
        return;
    showError('');
    const yName = $('qb-y')?.value ?? '';
    const xNames = Array.from(document.querySelectorAll('.qb-x-cb:checked'))
        .map(cb => cb.value)
        .filter(v => v !== yName);
    if (xNames.length === 0) {
        showError('Seleccioná al menos una variable X distinta de Y.');
        return;
    }
    try {
        const analysis = (0, autoRepair_1.autoRepairAndAnalyze)(csvData, yName, xNames);
        lastResult = analysis.result;
        lastCorr = analysis.corrMatrix;
        lastCorrCols = analysis.corrColumns;
        lastVIF = analysis.vifValues;
        renderRepairLog(analysis);
        renderResults(analysis.result, analysis.dropped, analysis.corrMatrix, analysis.corrColumns, analysis.vifValues);
        const res = $('qb-results');
        if (res) {
            res.style.display = '';
            res.scrollIntoView({ behavior: 'smooth' });
        }
    }
    catch (err) {
        showError(`Error en el análisis automático: ${err.message}`);
    }
}
// ── Init ──────────────────────────────────────────────────────────────────────
function init() {
    $('qb-file')?.addEventListener('change', onFileChange);
    $('qb-run')?.addEventListener('click', onRun);
    $('qb-auto-run')?.addEventListener('click', onAutoRun);
    $('qb-export-pdf')?.addEventListener('click', exportPDF);
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
}
else {
    init();
}

  __modules['main'] = module;
})();

// ─── Bootstrap ───────────────────────────────────────────────────────────────
__modules['main'].exports;
})();
