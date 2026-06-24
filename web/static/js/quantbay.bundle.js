/* quantbay.bundle.js — QuantBay OLS Regression
   Source: quantbay/src/*.ts
   CDN deps (loaded by template): PapaParse (window.Papa), Chart.js (window.Chart)
*/
(function () {
  'use strict';

  // ─── Matrix utilities ───────────────────────────────────────────────────────

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

  function matVecMul(A, v) {
    return A.map(row => dot(row, v));
  }

  function dot(a, b) {
    return a.reduce((s, ai, i) => s + ai * b[i], 0);
  }

  function arrMean(arr) {
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
        if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col])) maxRow = r;
      }
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-12) {
        throw new Error('Matriz singular: las variables pueden ser colineales.');
      }
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

  // ─── OLS Regression ─────────────────────────────────────────────────────────

  function runOLS({ X, y, featureNames, yName }) {
    const n = y.length;
    const k = X[0].length;
    if (n < k + 2) {
      throw new Error(`Se necesitan al menos ${k + 2} observaciones para ${k} variable(s).`);
    }

    const Xd = X.map(row => [1, ...row]);
    const Xt = transpose(Xd);
    const beta = matVecMul(matInv(matMul(Xt, Xd)), matVecMul(Xt, y));

    const intercept = beta[0];
    const coefficients = beta.slice(1);
    const predictions = Xd.map(row => dot(beta, row));
    const residuals = y.map((yi, i) => yi - predictions[i]);

    const yMean = arrMean(y);
    const ssTot = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
    const ssRes = residuals.reduce((s, r) => s + r ** 2, 0);
    const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
    const adjustedRSquared = 1 - (1 - rSquared) * (n - 1) / (n - k - 1);

    const terms = coefficients
      .map((c, i) => `${c >= 0 ? ' + ' : ' - '}${Math.abs(c).toFixed(4)}·${featureNames[i]}`)
      .join('');
    const equation = `${yName} = ${intercept.toFixed(4)}${terms}`;

    return { coefficients, intercept, rSquared, adjustedRSquared, predictions, residuals, equation, featureNames, yName, nObs: n, nFeatures: k };
  }

  // ─── CSV utilities ───────────────────────────────────────────────────────────

  function parseCSVFile(file) {
    const Papa = window.Papa;
    if (!Papa) return Promise.reject(new Error('PapaParse no disponible'));
    return new Promise((resolve, reject) => {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        dynamicTyping: true,
        complete(result) {
          const headers = result.meta.fields ?? [];
          const rows = result.data;
          const numericColumns = headers.filter(h =>
            rows.length > 0 &&
            rows.every(row => {
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

  // ─── Interpretation ──────────────────────────────────────────────────────────

  function interpret({ rSquared, adjustedRSquared, featureNames, coefficients, yName, nObs }) {
    const r2pct = (rSquared * 100).toFixed(1);
    const ar2pct = (adjustedRSquared * 100).toFixed(1);
    const quality = rSquared >= 0.8 ? 'muy bueno' : rSquared >= 0.5 ? 'moderado' : 'débil';

    const lines = [
      `El modelo explica el ${r2pct}% de la variación en "${yName}" (R² = ${rSquared.toFixed(4)}).`,
      `El ajuste es ${quality} (R² ajustado = ${ar2pct}%, n = ${nObs} observaciones).`,
      '',
      'Lectura de coeficientes (manteniendo el resto constante):',
      ...featureNames.map((name, i) => {
        const c = coefficients[i];
        const dir = c > 0 ? 'aumenta' : 'disminuye';
        return `  • Por cada unidad de aumento en "${name}", "${yName}" ${dir} en ${Math.abs(c).toFixed(4)} unidades.`;
      }),
      '',
      rSquared < 0.3
        ? '⚠ El R² bajo sugiere que las variables seleccionadas explican poca variación. Considerá agregar más predictores o revisar los datos.'
        : rSquared > 0.95
        ? '⚠ Un R² muy alto puede indicar sobreajuste o multicolinealidad. Verificá que las variables sean independientes entre sí.'
        : '',
      '',
      'Nota: OLS asume linealidad, homocedasticidad e independencia de los residuos.',
    ];

    return lines.filter((l, i, a) => !(l === '' && (i === 0 || a[i - 1] === ''))).join('\n');
  }

  // ─── UI state ────────────────────────────────────────────────────────────────

  let csvData = null;
  let activeChart = null;

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

  // ─── Variable selectors ───────────────────────────────────────────────────────

  function renderVarSelectors(cols) {
    const yEl = $('qb-y');
    const xEl = $('qb-x-checks');
    if (yEl) yEl.innerHTML = cols.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
    if (xEl)
      xEl.innerHTML = cols.map((c, i) =>
        `<label class="qb-x-check"><input type="checkbox" class="qb-x-cb" value="${esc(c)}" ${i > 0 ? 'checked' : ''}> ${esc(c)}</label>`
      ).join('');
  }

  // ─── Run regression ───────────────────────────────────────────────────────────

  function onRun() {
    if (!csvData) return;
    showError('');
    const yEl = $('qb-y');
    const yName = yEl ? yEl.value : '';
    const xNames = Array.from(document.querySelectorAll('.qb-x-cb:checked'))
      .map(cb => cb.value)
      .filter(v => v !== yName);

    if (xNames.length === 0) {
      showError('Seleccioná al menos una variable X distinta de Y.');
      return;
    }

    const { X, y, dropped } = getValidRows(csvData.rows, yName, xNames);
    if (y.length < xNames.length + 2) {
      showError(`Observaciones insuficientes (${y.length}) para ${xNames.length} variable(s).`);
      return;
    }

    try {
      const result = runOLS({ X, y, featureNames: xNames, yName });
      renderResults(result, dropped);
      const res = $('qb-results');
      if (res) { res.style.display = ''; res.scrollIntoView({ behavior: 'smooth' }); }
    } catch (err) {
      showError(`Error en la regresión: ${err.message}`);
    }
  }

  // ─── Results ─────────────────────────────────────────────────────────────────

  function renderResults(result, dropped) {
    const eq = $('qb-equation');
    if (eq) eq.textContent = result.equation;

    const coefBody = $('qb-coef-body');
    if (coefBody)
      coefBody.innerHTML = [
        `<tr><td>Intercepto</td><td>${result.intercept.toFixed(6)}</td></tr>`,
        ...result.featureNames.map((n, i) =>
          `<tr><td>${esc(n)}</td><td>${result.coefficients[i].toFixed(6)}</td></tr>`
        ),
      ].join('');

    const statsBody = $('qb-stats-body');
    if (statsBody)
      statsBody.innerHTML = `
        <tr><td>R&sup2;</td><td>${result.rSquared.toFixed(6)}</td></tr>
        <tr><td>R&sup2; ajustado</td><td>${result.adjustedRSquared.toFixed(6)}</td></tr>
        <tr><td>Observaciones (n)</td><td>${result.nObs}</td></tr>
        <tr><td>Variables (k)</td><td>${result.nFeatures}</td></tr>
        ${dropped > 0 ? `<tr><td>Filas omitidas (NA)</td><td>${dropped}</td></tr>` : ''}`;

    renderChart(result);

    const interp = $('qb-interpretation');
    if (interp) interp.textContent = interpret(result);

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
          {
            label: 'Observaciones',
            data: actual.map((a, i) => ({ x: a, y: result.predictions[i] })),
            backgroundColor: '#1b3a6b88',
            borderColor: '#1b3a6b',
            pointRadius: 5,
            pointHoverRadius: 7,
          },
          {
            label: 'Ajuste perfecto (y = x)',
            data: [{ x: minV - pad, y: minV - pad }, { x: maxV + pad, y: maxV + pad }],
            type: 'line',
            borderColor: '#b8860b',
            borderDash: [6, 4],
            borderWidth: 1.5,
            pointRadius: 0,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { font: { family: 'Verdana', size: 11 } } },
          title: {
            display: true,
            text: `${result.yName}: Real vs. Predicho`,
            font: { family: 'Verdana', size: 12 },
          },
        },
        scales: {
          x: { title: { display: true, text: `Real (${result.yName})`, font: { family: 'Verdana', size: 11 } } },
          y: { title: { display: true, text: `Predicho (${result.yName})`, font: { family: 'Verdana', size: 11 } } },
        },
      },
    });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    const fileInput = $('qb-file');
    if (fileInput) fileInput.addEventListener('change', onFileChange);
    const runBtn = $('qb-run');
    if (runBtn) runBtn.addEventListener('click', onRun);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
