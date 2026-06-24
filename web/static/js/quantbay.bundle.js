/* quantbay.bundle.js — Quant Bay Phase 2
   TypeScript source: quantbay/src/{statistics,regression,csvParser,interpretation,main}.ts
   CDN deps: PapaParse (window.Papa), Chart.js (window.Chart), jsPDF (window.jspdf)
*/
(function () {
  'use strict';

  // ─── Matrix utilities ────────────────────────────────────────────────────────

  function transpose(A) {
    const rows = A.length, cols = A[0].length;
    return Array.from({ length: cols }, (_, j) =>
      Array.from({ length: rows }, (_, i) => A[i][j])
    );
  }

  function matMul(A, B) {
    const m = A.length, n = B[0].length;
    return Array.from({ length: m }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        A[i].reduce((s, _, k) => s + A[i][k] * B[k][j], 0)
      )
    );
  }

  function matVecMul(A, v) { return A.map(row => dot(row, v)); }

  function dot(a, b) { return a.reduce((s, ai, i) => s + ai * b[i], 0); }

  function arrMean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }

  function matInv(A) {
    const n = A.length;
    const aug = A.map((row, i) => [
      ...row,
      ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    ]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col])) maxRow = r;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-12)
        throw new Error('Matriz singular: las variables pueden ser colineales.');
      for (let j = 0; j < 2 * n; j++) aug[col][j] /= pivot;
      for (let r = 0; r < n; r++) {
        if (r !== col) {
          const f = aug[r][col];
          for (let j = 0; j < 2 * n; j++) aug[r][j] -= f * aug[col][j];
        }
      }
    }
    return aug.map(row => row.slice(n));
  }

  // ─── Statistics ──────────────────────────────────────────────────────────────

  function gammaLn(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
               -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x;
    const tmp = x + 5.5;
    const base = -tmp + (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015;
    for (const ci of c) ser += ci / ++y;
    return base + Math.log(2.5066282746310005 * ser / x);
  }

  function betaLn(a, b) { return gammaLn(a) + gammaLn(b) - gammaLn(a + b); }

  function betaIncCF(x, a, b) {
    const EPS = 3e-7, FPMIN = 1e-30;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  function betaInc(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const lb = betaLn(a, b);
    if (x < (a + 1) / (a + b + 2))
      return Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lb) / a * betaIncCF(x, a, b);
    return 1 - Math.exp(b * Math.log(1 - x) + a * Math.log(x) - lb) / b * betaIncCF(1 - x, b, a);
  }

  function tDistPValue(t, df) {
    if (!isFinite(t) || df <= 0) return 0;
    return betaInc(df / (df + t * t), df / 2, 0.5);
  }

  function pearsonMatrix(columns) {
    const k = columns.length;
    if (k === 0) return [];
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
        const denom = Math.sqrt(di2 * dj2);
        corr[i][j] = corr[j][i] = denom === 0 ? (i === j ? 1 : 0) : num / denom;
      }
    }
    return corr;
  }

  // ─── OLS Regression (Phase 2) ────────────────────────────────────────────────

  function runOLS({ X, y, featureNames, yName }) {
    const n = y.length, k = X[0].length;
    if (n < k + 2)
      throw new Error(`Se necesitan al menos ${k + 2} observaciones para ${k} variable(s).`);

    const Xd = X.map(row => [1, ...row]);
    const Xt = transpose(Xd);
    const XtX = matMul(Xt, Xd);
    const XtXinv = matInv(XtX);
    const beta = matVecMul(XtXinv, matVecMul(Xt, y));

    const intercept = beta[0];
    const coefficients = beta.slice(1);
    const predictions = Xd.map(row => dot(beta, row));
    const residuals = y.map((yi, i) => yi - predictions[i]);

    const yMean = arrMean(y);
    const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
    const ssRes = residuals.reduce((s, r) => s + r ** 2, 0);
    const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
    const df = n - k - 1;
    const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / df;
    const sigma2 = df > 0 ? ssRes / df : 0;

    const stdErrors = XtXinv.map((row, i) => Math.sqrt(Math.max(0, sigma2 * row[i])));
    const tStats = beta.map((b, i) => stdErrors[i] > 1e-15 ? b / stdErrors[i] : Infinity);
    const pValues = tStats.map(t => tDistPValue(t, df));

    const terms = coefficients
      .map((c, i) => `${c >= 0 ? ' + ' : ' - '}${Math.abs(c).toFixed(4)}·${featureNames[i]}`)
      .join('');

    return {
      coefficients, intercept, rSquared, adjustedRSquared,
      predictions, residuals, equation: `${yName} = ${intercept.toFixed(4)}${terms}`,
      featureNames, yName, nObs: n, nFeatures: k,
      stdErrors, tStats, pValues, df, sigma2,
    };
  }

  function computeVIF(X) {
    const k = X[0] ? X[0].length : 0;
    if (k <= 1) return new Array(k).fill(1);
    return Array.from({ length: k }, (_, j) => {
      const yVIF = X.map(row => row[j]);
      const xOther = X.map(row => row.filter((_, c) => c !== j));
      try {
        const res = runOLS({ X: xOther, y: yVIF,
          featureNames: xOther[0].map((_, i) => 'x' + i), yName: 'x' + j });
        return 1 / (1 - Math.max(0, Math.min(0.9999, res.rSquared)));
      } catch (_) { return 999; }
    });
  }

  // ─── Binary target detection ──────────────────────────────────────────────────

  function isBinaryTarget(y) {
    return new Set(y).size === 2;
  }

  // ─── Logistic Regression (gradient descent, no external deps) ────────────────

  function sigmoid(z) {
    if (z > 500) return 1;
    if (z < -500) return 0;
    return 1 / (1 + Math.exp(-z));
  }

  function runLogistic({ X, y, featureNames, yName, maxIter = 1500, lr = 0.05 }) {
    const n = y.length;
    const yVals = [...new Set(y)].sort((a, b) => a - b);
    const yBin = y.map(v => v === yVals[1] ? 1 : 0);
    const Xd = X.map(row => [1, ...row]);
    const p = Xd[0].length;

    let beta = new Array(p).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
      const probs = Xd.map(row => sigmoid(dot(beta, row)));
      const errors = probs.map((pi, i) => pi - yBin[i]);
      const grad = Array.from({ length: p }, (_, j) =>
        Xd.reduce((s, row, i) => s + row[j] * errors[i], 0) / n
      );
      beta = beta.map((b, j) => b - lr * grad[j]);
    }

    const probs = Xd.map(row => sigmoid(dot(beta, row)));
    const eps = 1e-15;
    const llModel = probs.reduce((s, pi, i) =>
      s + yBin[i] * Math.log(Math.max(eps, pi)) + (1 - yBin[i]) * Math.log(Math.max(eps, 1 - pi)), 0);

    const pMean = yBin.reduce((s, v) => s + v, 0) / n;
    const llNull = n * (pMean * Math.log(Math.max(eps, pMean)) + (1 - pMean) * Math.log(Math.max(eps, 1 - pMean)));

    const mcFaddenR2 = llNull !== 0 ? Math.max(0, 1 - llModel / llNull) : 0;
    const predicted = probs.map(pi => pi >= 0.5 ? 1 : 0);
    const accuracy = predicted.filter((p, i) => p === yBin[i]).length / n;

    return {
      intercept: beta[0],
      coefficients: beta.slice(1),
      oddsRatios: beta.slice(1).map(c => Math.exp(c)),
      mcFaddenR2, accuracy, llModel, llNull,
      featureNames, yName, yVals, n,
    };
  }

  // ─── Data leakage detection ───────────────────────────────────────────────────

  const LEAK_THRESHOLD = 0.95;

  function detectLeakage(X, y, xNames, threshold = LEAK_THRESHOLD) {
    const n = y.length;
    const yMean = arrMean(y);
    const yDev = y.map(v => v - yMean);
    const yVar = yDev.reduce((s, d) => s + d * d, 0);
    return xNames.map((name, j) => {
      const xCol = X.map(row => row[j]);
      const xMean = arrMean(xCol);
      const xDev = xCol.map(v => v - xMean);
      const num = xDev.reduce((s, d, i) => s + d * yDev[i], 0);
      const denom = Math.sqrt(xDev.reduce((s, d) => s + d * d, 0) * yVar);
      const r = denom === 0 ? 0 : num / denom;
      return { name, r, abs: Math.abs(r) };
    }).filter(d => d.abs >= threshold);
  }

  // ─── CSV utilities ───────────────────────────────────────────────────────────

  function parseCSVFile(file) {
    const Papa = window.Papa;
    if (!Papa) return Promise.reject(new Error('PapaParse no disponible'));
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true, skipEmptyLines: true, dynamicTyping: true,
        complete(result) {
          const headers = result.meta.fields ?? [];
          const rows = result.data;
          const numericColumns = headers.filter(h =>
            rows.length > 0 && rows.every(row => {
              const v = row[h];
              return v !== null && v !== '' && !isNaN(Number(v));
            })
          );
          resolve({ headers, rows, numericColumns });
        },
        error(err) { reject(new Error(String(err))); },
      });
    });
  }

  function getValidRows(rows, yName, xNames) {
    const allCols = [yName, ...xNames];
    const valid = rows.filter(row =>
      allCols.every(col => { const v = Number(row[col]); return !isNaN(v) && isFinite(v); })
    );
    return {
      X: valid.map(row => xNames.map(col => Number(row[col]))),
      y: valid.map(row => Number(row[yName])),
      dropped: rows.length - valid.length,
    };
  }

  function getAllNumericData(rows, colNames) {
    const valid = rows.filter(row =>
      colNames.every(c => { const v = Number(row[c]); return !isNaN(v) && isFinite(v); })
    );
    return colNames.map(col => valid.map(row => Number(row[col])));
  }

  // ─── Interpretation (Phase 2) ────────────────────────────────────────────────

  function interpret({ rSquared, adjustedRSquared, featureNames, coefficients, yName, nObs, pValues, isBinary }) {
    const r2pct = (rSquared * 100).toFixed(1);
    const ar2pct = (adjustedRSquared * 100).toFixed(1);
    const quality = rSquared >= 0.8 ? 'muy bueno' : rSquared >= 0.5 ? 'moderado' : 'débil';
    const sigCount = pValues ? pValues.slice(1).filter(p => p < 0.05).length : 0;
    const totalCoef = featureNames.length;

    const lines = [
      `El modelo explica el ${r2pct}% de la variación en “${yName}” (R² = ${rSquared.toFixed(4)}).`,
      `El ajuste es ${quality} (R² ajustado = ${ar2pct}%, n = ${nObs} observaciones).`,
      '',
      pValues
        ? (sigCount === totalCoef
            ? 'Significancia: todas las variables son estadísticamente significativas (p < 0.05).'
            : sigCount === 0
            ? 'Significancia: ninguna variable resulta estadísticamente significativa (p < 0.05). El modelo puede estar mal especificado o los datos ser insuficientes.'
            : `Significancia: ${sigCount} de ${totalCoef} variable(s) son estadísticamente significativas (p < 0.05).`)
        : '',
      '',
      isBinary
        ? `Lectura de coeficientes OLS — Modelo de Probabilidad Lineal (¡limitado para 0/1!):`
        : 'Lectura de coeficientes (manteniendo el resto constante):',
      ...featureNames.map((name, i) => {
        const c = coefficients[i];
        const pSig = pValues && pValues[i + 1] >= 0.05 ? ' (no significativo estadísticamente)' : '';
        if (isBinary) {
          const pp = (Math.abs(c) * 100).toFixed(2);
          const dir = c > 0 ? 'aumenta' : 'reduce';
          return `  • Por cada unidad de aumento en “${name}”, el modelo ${dir} la probabilidad estimada de “${yName}=1” en ~${pp} pp (interpretación LPM, aproximada)${pSig}.`;
        }
        const dir = c > 0 ? 'aumenta' : 'disminuye';
        return `  • Por cada unidad de aumento en “${name}”, “${yName}” ${dir} en ${Math.abs(c).toFixed(4)} unidades${pSig}.`;
      }),
      '',
      rSquared < 0.3
        ? '⚠ El R² bajo sugiere que las variables seleccionadas explican poca variación. Considerá agregar más predictores o revisar los datos.'
        : rSquared > 0.95
        ? '⚠ Un R² muy alto puede indicar sobreajuste o multicolinealidad — o fuga de datos. Verificá los regresores.'
        : '',
      '',
      'Nota: OLS asume linealidad, homocedasticidad e independencia de los residuos. Verificá estos supuestos antes de usar el modelo.',
      'Nota educativa: Un R² cercano a 1 casi siempre es señal de fuga de datos o sobreajuste, no de un buen modelo. Sospechá de los resultados demasiado perfectos.',
    ];

    return lines.filter((l, i, a) => !(l === '' && (i === 0 || a[i - 1] === ''))).join('\n');
  }

  // ─── UI state ────────────────────────────────────────────────────────────────

  let csvData = null;
  let activeChart = null;
  let residFittedChart = null;
  let residHistChart = null;
  let lastResult = null;
  let lastCorr = null;
  let lastCorrCols = null;
  let lastVIF = null;
  let lastLogit = null;

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
  );

  function showError(msg) {
    const el = $('qb-error');
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? '' : 'none';
  }

  function sigBadge(p) {
    if (p < 0.01) return '<span class="sig-badge sig-h">*** p&lt;0.01</span>';
    if (p < 0.05) return '<span class="sig-badge sig-m">** p&lt;0.05</span>';
    if (p < 0.10) return '<span class="sig-badge sig-l">* p&lt;0.10</span>';
    return '<span class="sig-badge sig-n">n.s.</span>';
  }

  function sigLabel(p) {
    if (p < 0.01) return '***';
    if (p < 0.05) return '**';
    if (p < 0.10) return '*';
    return 'n.s.';
  }

  function corrCls(r, isDiag) {
    if (isDiag) return 'corr-diag';
    if (r >= 0.7)  return 'corr-sp';
    if (r <= -0.7) return 'corr-sn';
    if (r >= 0.3)  return 'corr-mp';
    if (r <= -0.3) return 'corr-mn';
    return 'corr-w';
  }

  // ─── Upload ──────────────────────────────────────────────────────────────────

  async function onFileChange(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    showError('');
    const fn = $('qb-filename');
    if (fn) fn.textContent = file.name;
    try {
      csvData = await parseCSVFile(file);
      if (csvData.numericColumns.length < 2) {
        showError('El CSV necesita al menos 2 columnas numéricas.');
        return;
      }
      renderPreview(csvData);
      renderVarSelectors(csvData.numericColumns);
      const preview = $('qb-preview'), vars = $('qb-vars'), results = $('qb-results');
      if (preview) preview.style.display = '';
      if (vars) vars.style.display = '';
      if (results) results.style.display = 'none';
    } catch (err) {
      showError(`Error al leer el archivo: ${err.message}`);
    }
  }

  // ─── Preview ─────────────────────────────────────────────────────────────────

  function renderPreview({ headers, rows, numericColumns }) {
    const preview = rows.slice(0, 6);
    const thead = `<tr>${headers.map(h => `<th>${esc(h)}</th>`).join('')}</tr>`;
    const tbody = preview.map(row =>
      `<tr>${headers.map(h => `<td>${esc(row[h])}</td>`).join('')}</tr>`
    ).join('');
    const wrap = $('qb-table-wrap');
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="qb-table-scroll">
        <table class="ledger"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
      </div>
      <p class="muted" style="font-size:11px;margin:4px 0 0">
        ${preview.length} de ${rows.length} filas &middot; ${headers.length} columnas &middot;
        <strong>${numericColumns.length} num&eacute;ricas</strong>
      </p>`;
  }

  // ─── Variable Selectors ───────────────────────────────────────────────────────

  function renderVarSelectors(cols) {
    const yEl = $('qb-y');
    const xEl = $('qb-x-checks');
    if (yEl) yEl.innerHTML = cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (xEl)
      xEl.innerHTML = cols.map((c, i) =>
        `<label class="qb-x-check"><input type="checkbox" class="qb-x-cb" value="${esc(c)}" ${i > 0 ? 'checked' : ''}> ${esc(c)}</label>`
      ).join('');
  }

  // ─── Run Regression ──────────────────────────────────────────────────────────

  function onRun() {
    if (!csvData) return;
    showError('');
    const yEl = $('qb-y');
    const yName = yEl ? yEl.value : '';
    const xNames = Array.from(document.querySelectorAll('.qb-x-cb:checked'))
      .map(cb => cb.value).filter(v => v !== yName);

    if (xNames.length === 0) { showError('Seleccioná al menos una variable X distinta de Y.'); return; }

    const { X, y, dropped } = getValidRows(csvData.rows, yName, xNames);
    if (y.length < xNames.length + 2) {
      showError(`Observaciones insuficientes (${y.length}) para ${xNames.length} variable(s).`);
      return;
    }

    try {
      const result = runOLS({ X, y, featureNames: xNames, yName });

      const allColData = getAllNumericData(csvData.rows, csvData.numericColumns);
      const corrMatrix = pearsonMatrix(allColData);
      const vifValues = computeVIF(X);
      const binary = isBinaryTarget(y);
      const leaks = detectLeakage(X, y, xNames);
      let logitResult = null;
      if (binary) {
        try { logitResult = runLogistic({ X, y, featureNames: xNames, yName }); } catch (_) {}
      }

      lastResult = result;
      lastCorr = corrMatrix;
      lastCorrCols = csvData.numericColumns;
      lastVIF = vifValues;
      lastLogit = logitResult;

      renderResults(result, dropped, corrMatrix, csvData.numericColumns, vifValues, { binary, logitResult, leaks });
      const res = $('qb-results');
      if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
    } catch (err) {
      showError(`Error en la regresión: ${err.message}`);
    }
  }

  // ─── Results ─────────────────────────────────────────────────────────────────

  function renderResults(result, dropped, corrMatrix, corrCols, vifValues, checks = {}) {
    const { binary = false, logitResult = null, leaks = [] } = checks;

    renderBinaryWarn(binary, result.yName);
    renderLeakageWarn(leaks);

    const eq = $('qb-equation');
    if (eq) eq.textContent = result.equation;

    renderCoefTable(result);
    renderStatsTable(result, dropped);
    renderLogistic(logitResult);
    renderChart(result);
    renderCorrMatrix(corrMatrix, corrCols);
    renderVIF(vifValues, result.featureNames);
    renderResidDiag(result);

    const interp = $('qb-interpretation');
    if (interp) interp.textContent = interpret({ ...result, isBinary: binary });

    const actual = result.predictions.map((p, i) => p + result.residuals[i]);
    const predTable = $('qb-pred-table');
    if (predTable)
      predTable.innerHTML = `
        <table class="ledger" style="margin-top:8px">
          <thead><tr><th>#</th><th>Real</th><th>Predicho</th><th>Residuo</th></tr></thead>
          <tbody>${result.predictions.map((p, i) =>
            `<tr><td>${i + 1}</td><td>${actual[i].toFixed(4)}</td><td>${p.toFixed(4)}</td><td>${result.residuals[i].toFixed(4)}</td></tr>`
          ).join('')}</tbody>
        </table>`;
  }

  // ─── Binary warning ───────────────────────────────────────────────────────────

  function renderBinaryWarn(isBinary, yName) {
    const el = $('qb-binary-warn');
    if (!el) return;
    if (!isBinary) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="qb-warn-yellow">
        <p><strong>⚠ La variable dependiente es binaria (0/1) — Modelo de Probabilidad Lineal</strong></p>
        <p>Estás corriendo OLS sobre una variable 0/1. Esto se llama <em>Modelo de Probabilidad Lineal (MPL)</em>: técnicamente válido pero con limitaciones importantes:</p>
        <ul style="margin:4px 0 0 16px;padding:0">
          <li>Las predicciones pueden caer <strong>fuera de [0, 1]</strong> (probabilidades negativas o &gt; 1).</li>
          <li>La interpretación "aumenta N unidades" <strong>NO aplica</strong> a una probabilidad; usá "aumenta ~N·100 puntos porcentuales (aprox.)".</li>
          <li>Un R² alto en una regresión binaria puede ser engañoso.</li>
          <li>Los residuos violan homocedasticidad por definición.</li>
        </ul>
        <p style="margin-top:6px">Para 0/1 lo correcto es una <strong>regresión LOGÍSTICA</strong>. Los resultados logísticos se muestran debajo de los coeficientes OLS.</p>
      </div>`;
  }

  // ─── Leakage warning ──────────────────────────────────────────────────────────

  function renderLeakageWarn(leaks) {
    const el = $('qb-leak-warn');
    if (!el) return;
    if (!leaks || leaks.length === 0) { el.innerHTML = ''; return; }
    const items = leaks.map(d =>
      `<p>⚠ <strong>«${esc(d.name)}»</strong> correlaciona <strong>${d.r.toFixed(4)}</strong> (|r| = ${d.abs.toFixed(4)}) con el objetivo. Puede ser un regresor derivado de la respuesta (p. ej. una interacción o transformación que contiene la propia variable dependiente). Esto infla artificialmente el R² — el modelo no está "prediciendo" realmente. Revisá y/o quitá esa variable.</p>`
    ).join('');
    el.innerHTML = `
      <div class="qb-warn-red">
        <p><strong>🚨 POSIBLE FUGA DE DATOS (Data Leakage)</strong></p>
        ${items}
        <p style="margin-top:4px;font-style:italic">Umbral: |r| ≥ ${LEAK_THRESHOLD}.</p>
      </div>`;
  }

  // ─── Logistic results ─────────────────────────────────────────────────────────

  function renderLogistic(res) {
    const wrap = $('qb-logit-wrap');
    const content = $('qb-logit-content');
    if (!wrap || !content) return;
    if (!res) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    const f4 = n => isFinite(n) ? n.toFixed(4) : '—';
    const rows = res.featureNames.map((name, i) =>
      `<tr><td>${esc(name)}</td><td>${f4(res.coefficients[i])}</td><td>${f4(res.oddsRatios[i])}</td></tr>`
    ).join('');

    content.innerHTML = `
      <div style="overflow-x:auto">
        <table class="ledger" style="margin-bottom:8px">
          <thead><tr><th>Variable</th><th>Coef. logístico</th><th>Odds Ratio (exp β)</th></tr></thead>
          <tbody>
            <tr><td>Intercepto</td><td>${f4(res.intercept)}</td><td>${f4(Math.exp(res.intercept))}</td></tr>
            ${rows}
          </tbody>
        </table>
      </div>
      <table class="ledger" style="width:auto">
        <thead><tr><th>Indicador</th><th>Valor</th></tr></thead>
        <tbody>
          <tr><td>Pseudo R² (McFadden)</td><td>${res.mcFaddenR2.toFixed(4)}</td></tr>
          <tr><td>Log-verosimilitud modelo</td><td>${res.llModel.toFixed(4)}</td></tr>
          <tr><td>Log-verosimilitud nulo</td><td>${res.llNull.toFixed(4)}</td></tr>
          <tr><td>Exactitud en muestra</td><td>${(res.accuracy * 100).toFixed(1)}%</td></tr>
          <tr><td>n observaciones</td><td>${res.n}</td></tr>
        </tbody>
      </table>
      <p style="font-size:10px;color:#666;margin:6px 0 0;font-family:Verdana,Arial,sans-serif">
        Odds Ratio > 1: aumenta la probabilidad de ${esc(res.yName)}=1 &middot; OR &lt; 1: la reduce &middot;
        Pseudo R² de McFadden: 0.2–0.4 se considera buen ajuste en logística.
      </p>`;
  }

  function renderCoefTable(result) {
    const body = $('qb-coef-body');
    if (!body) return;
    const f6 = n => isFinite(n) ? n.toFixed(6) : '—';
    const f4 = n => isFinite(n) ? n.toFixed(4) : '—';
    body.innerHTML = [
      `<tr><td>Intercepto</td><td>${f6(result.intercept)}</td><td>${f6(result.stdErrors[0])}</td><td>${f4(result.tStats[0])}</td><td>${f4(result.pValues[0])}</td><td>${sigBadge(result.pValues[0])}</td></tr>`,
      ...result.featureNames.map((n, i) =>
        `<tr><td>${esc(n)}</td><td>${f6(result.coefficients[i])}</td><td>${f6(result.stdErrors[i+1])}</td><td>${f4(result.tStats[i+1])}</td><td>${f4(result.pValues[i+1])}</td><td>${sigBadge(result.pValues[i+1])}</td></tr>`
      ),
    ].join('');
  }

  function renderStatsTable(result, dropped) {
    const body = $('qb-stats-body');
    if (!body) return;
    body.innerHTML = `
      <tr><td>R&sup2;</td><td>${result.rSquared.toFixed(6)}</td></tr>
      <tr><td>R&sup2; ajustado</td><td>${result.adjustedRSquared.toFixed(6)}</td></tr>
      <tr><td>Observaciones (n)</td><td>${result.nObs}</td></tr>
      <tr><td>Variables (k)</td><td>${result.nFeatures}</td></tr>
      <tr><td>Grados de libertad</td><td>${result.df}</td></tr>
      <tr><td>&sigma;&sup2; (var. residual)</td><td>${result.sigma2.toFixed(6)}</td></tr>
      ${dropped > 0 ? `<tr><td>Filas omitidas (NA)</td><td>${dropped}</td></tr>` : ''}`;
  }

  function renderChart(result) {
    const canvas = $('qb-chart');
    if (activeChart) { activeChart.destroy(); activeChart = null; }
    const ChartJS = window.Chart;
    if (!ChartJS || !canvas) return;

    const actual = result.predictions.map((p, i) => p + result.residuals[i]);
    const allV = [...actual, ...result.predictions];
    const minV = Math.min(...allV), maxV = Math.max(...allV);
    const pad = (maxV - minV) * 0.05 || 1;

    activeChart = new ChartJS(canvas, {
      type: 'scatter',
      data: {
        datasets: [
          { label: 'Observaciones', data: actual.map((a, i) => ({ x: a, y: result.predictions[i] })),
            backgroundColor: '#1b3a6b88', borderColor: '#1b3a6b', pointRadius: 5, pointHoverRadius: 7 },
          { label: 'Ajuste perfecto (y = x)',
            data: [{ x: minV - pad, y: minV - pad }, { x: maxV + pad, y: maxV + pad }],
            type: 'line', borderColor: '#b8860b', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { font: { family: 'Verdana', size: 11 } } },
          title: { display: true, text: `${result.yName}: Real vs. Predicho`, font: { family: 'Verdana', size: 12 } },
        },
        scales: {
          x: { title: { display: true, text: `Real (${result.yName})`, font: { family: 'Verdana', size: 11 } } },
          y: { title: { display: true, text: `Predicho (${result.yName})`, font: { family: 'Verdana', size: 11 } } },
        },
      },
    });
  }

  // ─── Correlation Matrix ──────────────────────────────────────────────────────

  function renderCorrMatrix(corrMatrix, colNames) {
    const wrap = $('qb-corr-wrap');
    if (!wrap || !corrMatrix || corrMatrix.length === 0) return;
    const k = colNames.length;
    const abbr = n => n.length > 9 ? n.slice(0, 8) + '…' : n;

    let html = '<table class="ledger qb-corr-table"><thead><tr><th></th>';
    html += colNames.map(n => `<th title="${esc(n)}">${esc(abbr(n))}</th>`).join('');
    html += '</tr></thead><tbody>';
    for (let i = 0; i < k; i++) {
      html += `<tr><th title="${esc(colNames[i])}">${esc(abbr(colNames[i]))}</th>`;
      for (let j = 0; j < k; j++) {
        const r = corrMatrix[i][j];
        html += `<td class="${corrCls(r, i === j)}">${r.toFixed(3)}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    wrap.innerHTML = html;

    const interpEl = $('qb-corr-interp');
    if (!interpEl) return;
    const lines = [];
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const r = corrMatrix[i][j];
        const abs = Math.abs(r);
        if (abs >= 0.7) {
          const dir = r > 0 ? 'positiva' : 'negativa';
          const str = abs >= 0.9 ? 'muy fuerte' : 'fuerte';
          lines.push(`“${colNames[i]}” y “${colNames[j]}” — correlación ${dir} ${str} (r = ${r.toFixed(3)}).`);
        }
      }
    }
    interpEl.textContent = lines.length > 0
      ? lines.join('\n')
      : 'No se detectan correlaciones fuertes (|r| ≥ 0.70) entre las variables.';
    interpEl.style.display = '';
  }

  // ─── VIF ─────────────────────────────────────────────────────────────────────

  function renderVIF(vifValues, xNames) {
    const wrap = $('qb-vif-wrap');
    const warnEl = $('qb-vif-warn');
    if (!wrap) return;

    if (!vifValues || vifValues.length === 0) {
      wrap.innerHTML = '<p class="muted" style="font-size:11px">VIF no disponible con un solo predictor.</p>';
      return;
    }

    const warnings = [];
    let html = '<table class="ledger"><thead><tr><th>Variable</th><th>VIF</th><th>Estado</th></tr></thead><tbody>';
    vifValues.forEach((v, i) => {
      const vStr = v >= 999 ? '&gt;999' : v.toFixed(2);
      let cls, label;
      if (v >= 10) {
        cls = 'qb-vif-high'; label = '⚠ Severo';
        warnings.push(`“${xNames[i]}” (VIF ${v >= 999 ? '>999' : v.toFixed(1)}): multicolinealidad severa — los coeficientes pueden ser inestables.`);
      } else if (v >= 5) {
        cls = 'qb-vif-med'; label = '△ Precaución';
      } else {
        cls = 'qb-vif-ok'; label = '✓ Aceptable';
      }
      html += `<tr><td>${esc(xNames[i])}</td><td>${vStr}</td><td class="${cls}">${label}</td></tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    if (warnEl)
      warnEl.innerHTML = warnings.length > 0
        ? `<div class="qb-warn">${warnings.map(w => `<p>${esc(w)}</p>`).join('')}</div>`
        : '';
  }

  // ─── Residual Diagnostics ────────────────────────────────────────────────────

  function renderResidDiag(result) {
    const ChartJS = window.Chart;
    if (!ChartJS) return;

    const rfCanvas = $('qb-resid-fitted');
    if (rfCanvas) {
      if (residFittedChart) { residFittedChart.destroy(); residFittedChart = null; }
      const minP = Math.min(...result.predictions);
      const maxP = Math.max(...result.predictions);
      residFittedChart = new ChartJS(rfCanvas, {
        type: 'scatter',
        data: {
          datasets: [
            { label: 'Residuos', data: result.predictions.map((p, i) => ({ x: p, y: result.residuals[i] })),
              backgroundColor: '#1b3a6b88', borderColor: '#1b3a6b', pointRadius: 4 },
            { label: 'y=0', type: 'line', data: [{ x: minP, y: 0 }, { x: maxP, y: 0 }],
              borderColor: '#b8860b', borderDash: [5, 3], borderWidth: 1.5, pointRadius: 0, fill: false },
          ],
        },
        options: {
          responsive: true,
          plugins: {
            legend: { display: false },
            title: { display: true, text: 'Residuos vs. Ajustados', font: { family: 'Verdana', size: 11 } },
          },
          scales: {
            x: { title: { display: true, text: 'Valor ajustado', font: { family: 'Verdana', size: 10 } } },
            y: { title: { display: true, text: 'Residuo', font: { family: 'Verdana', size: 10 } } },
          },
        },
      });
    }

    const histCanvas = $('qb-resid-hist');
    if (histCanvas) {
      if (residHistChart) { residHistChart.destroy(); residHistChart = null; }
      const resids = result.residuals;
      const minR = Math.min(...resids), maxR = Math.max(...resids);
      const bins = Math.min(10, Math.max(3, Math.floor(Math.sqrt(resids.length))));
      const bw = (maxR - minR) / bins || 1;
      const counts = new Array(bins).fill(0);
      resids.forEach(r => { const idx = Math.min(Math.floor((r - minR) / bw), bins - 1); counts[idx]++; });
      const labels = Array.from({ length: bins }, (_, i) => (minR + (i + 0.5) * bw).toFixed(2));
      residHistChart = new ChartJS(histCanvas, {
        type: 'bar',
        data: { labels, datasets: [{ data: counts, backgroundColor: '#1b3a6b88', borderColor: '#1b3a6b', borderWidth: 1 }] },
        options: {
          responsive: true,
          plugins: {
            legend: { display: false },
            title: { display: true, text: 'Distribución de Residuos', font: { family: 'Verdana', size: 11 } },
          },
          scales: {
            x: { title: { display: true, text: 'Residuo', font: { family: 'Verdana', size: 10 } } },
            y: { title: { display: true, text: 'Frecuencia', font: { family: 'Verdana', size: 10 } }, beginAtZero: true },
          },
        },
      });
    }

    const statsEl = $('qb-resid-stats');
    if (statsEl) {
      const resids = result.residuals, n = resids.length;
      const mn = resids.reduce((s, r) => s + r, 0) / n;
      const sd = Math.sqrt(resids.reduce((s, r) => s + (r - mn) ** 2, 0) / Math.max(1, n - 1));
      statsEl.innerHTML = `<p class="qb-resid-stat-line">Media de residuos: <strong>${mn.toFixed(6)}</strong> &nbsp;&middot;&nbsp; Desv. est&aacute;ndar: <strong>${sd.toFixed(6)}</strong></p>`;
    }
  }

  // ─── PDF Export ──────────────────────────────────────────────────────────────

  function exportPDF() {
    const jspdfLib = window.jspdf;
    if (!jspdfLib || !jspdfLib.jsPDF) {
      alert('jsPDF no está disponible. Verificá que el CDN cargó correctamente.');
      return;
    }
    if (!lastResult) { alert('Primero ejecutá una regresión.'); return; }

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
        head: [['Variable', 'Coef.', 'Err. Est.', 't-stat', 'p-valor', 'Signif.']],
        body: [
          ['Intercepto', lastResult.intercept.toFixed(6), lastResult.stdErrors[0].toFixed(6),
           isFinite(lastResult.tStats[0]) ? lastResult.tStats[0].toFixed(4) : '—',
           lastResult.pValues[0].toFixed(4), sigLabel(lastResult.pValues[0])],
          ...lastResult.featureNames.map((n, i) => [n,
            lastResult.coefficients[i].toFixed(6),
            lastResult.stdErrors[i+1].toFixed(6),
            isFinite(lastResult.tStats[i+1]) ? lastResult.tStats[i+1].toFixed(4) : '—',
            lastResult.pValues[i+1].toFixed(4), sigLabel(lastResult.pValues[i+1])]),
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
      if (y > 220) { doc.addPage(); y = 15; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text('Real vs. Predicho', 10, y); y += 4;
      try { doc.addImage(chartCanvas.toDataURL('image/png'), 'PNG', 10, y, W, 65); y += 69; } catch (_) {}
    }

    if (lastCorr && lastCorrCols && doc.autoTable) {
      if (y > 200) { doc.addPage(); y = 15; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text('Matriz de Correlación de Pearson', 10, y); y += 4;
      doc.autoTable({
        head: [['', ...lastCorrCols]],
        body: lastCorr.map((row, i) => [lastCorrCols[i], ...row.map(v => v.toFixed(3))]),
        startY: y, styles: { fontSize: 7 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
      });
      y = doc.lastAutoTable.finalY + 5;
    }

    if (lastVIF && lastResult && doc.autoTable) {
      if (y > 220) { doc.addPage(); y = 15; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text('Diagnóstico de Multicolinealidad (VIF)', 10, y); y += 4;
      doc.autoTable({
        head: [['Variable', 'VIF', 'Estado']],
        body: lastVIF.map((v, i) => [
          lastResult.featureNames[i], v >= 999 ? '>999' : v.toFixed(2),
          v >= 10 ? 'Severo' : v >= 5 ? 'Precaución' : 'Aceptable',
        ]),
        startY: y, styles: { fontSize: 8 }, headStyles: { fillColor: [27, 58, 107] }, margin: { left: 10, right: 10 },
      });
      y = doc.lastAutoTable.finalY + 5;
    }

    const rfCanvas = $('qb-resid-fitted'), rhCanvas = $('qb-resid-hist');
    if (rfCanvas || rhCanvas) {
      if (y > 200) { doc.addPage(); y = 15; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
      doc.text('Diagnósticos de Residuos', 10, y); y += 4;
      try {
        if (rfCanvas) doc.addImage(rfCanvas.toDataURL('image/png'), 'PNG', 10, y, 90, 55);
        if (rhCanvas) doc.addImage(rhCanvas.toDataURL('image/png'), 'PNG', 105, y, 90, 55);
        y += 59;
      } catch (_) {}
    }

    if (y > 230) { doc.addPage(); y = 15; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10);
    doc.text('Interpretación Automática', 10, y); y += 5;
    const interpEl = $('qb-interpretation');
    if (interpEl) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
      const lines = doc.splitTextToSize(interpEl.textContent || '', W);
      doc.text(lines, 10, y);
    }

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
      doc.setPage(i);
      doc.setFont('helvetica', 'italic'); doc.setFontSize(7);
      doc.text('Análisis estadístico educativo · No constituye asesoramiento financiero.', 10, 290);
      doc.text(`Pág. ${i}/${pageCount}`, 185, 290);
    }

    doc.save('quantbay_regresion.pdf');
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    const fileInput = $('qb-file');
    if (fileInput) fileInput.addEventListener('change', onFileChange);
    const runBtn = $('qb-run');
    if (runBtn) runBtn.addEventListener('click', onRun);
    const pdfBtn = $('qb-export-pdf');
    if (pdfBtn) pdfBtn.addEventListener('click', exportPDF);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
