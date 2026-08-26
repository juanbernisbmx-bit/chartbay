import type { RegressionResult } from '../regression';
import type { LeakageSignal } from '../services/analysisService';
import type { AutoRepairResult } from '../services/autoRepair';
import { $ } from '../app/dom';
import { appState } from '../app/state';
import { correlationClass, escapeHtml } from '../utils/format';

declare const Chart: any;

export function chartTheme(title: string, xTitle: string, yTitle: string, legend = true): Record<string, unknown> {
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


export function renderBinaryWarn(isBinary: boolean, yName: string): void {
  const el = $('qb-binary-warn');
  if (!el) return;
  if (!isBinary) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="qb-warn-yellow">
      <p><strong>Variable dependiente binaria detectada: ${escapeHtml(yName)}</strong></p>
      <p>Se está usando OLS como modelo de probabilidad lineal. Las predicciones pueden quedar fuera del rango [0,1], la varianza residual no es constante y los coeficientes se interpretan como cambios aproximados en puntos porcentuales.</p>
      <p>Se muestra una regresión logística a continuación para comparar.</p>
    </div>`;
}

export function renderLeakageWarn(leaks: LeakageSignal[]): void {
  const el = $('qb-leak-warn');
  if (!el) return;
  if (!leaks.length) {
    el.innerHTML = '';
    return;
  }
  const rows = leaks
    .map(
      leak =>
        `<p><strong>${escapeHtml(leak.name)}</strong>: correlación ${leak.r.toFixed(4)} con la variable dependiente (|r| = ${leak.abs.toFixed(4)}).</p>`
    )
    .join('');

  if (appState.activeDemoId) {
    // Demo datasets are intentionally built with strong linear relationships
    el.innerHTML = `
      <div class="qb-warn-yellow">
        <p><strong>Alta correlación detectada</strong></p>
        ${rows}
        <p>Este demo está diseñado para mostrar una relación lineal fuerte. En datos reales, revisá que los predictores no se deriven de la variable dependiente antes de usar el modelo. Umbral: |r| ≥ 0.95.</p>
      </div>`;
  } else {
    el.innerHTML = `
      <div class="qb-warn-red">
        <p><strong>Posible data leakage detectado</strong></p>
        ${rows}
        <p>Revisá si este predictor se deriva de la respuesta o fue construido a partir de ella. Umbral: |r| ≥ 0.95.</p>
      </div>`;
  }
}

export function renderCorrMatrix(corrMatrix: number[][], colNames: string[]): void {
  const wrap = $('qb-corr-wrap');
  if (!wrap || !corrMatrix || corrMatrix.length === 0) return;
  const k = colNames.length;
  const abbr = (n: string) => (n.length > 9 ? n.slice(0, 8) + '…' : n);

  let html = '<table class="ledger qb-corr-table"><thead><tr><th></th>';
  html += colNames.map(n => `<th title="${escapeHtml(n)}">${escapeHtml(abbr(n))}</th>`).join('');
  html += '</tr></thead><tbody>';
  for (let i = 0; i < k; i++) {
    html += `<tr><th title="${escapeHtml(colNames[i])}">${escapeHtml(abbr(colNames[i]))}</th>`;
    for (let j = 0; j < k; j++) {
      const r = corrMatrix[i][j];
      html += `<td class="${correlationClass(r, i === j)}">${r.toFixed(3)}</td>`;
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;

  const interpEl = $('qb-corr-interp');
  if (!interpEl) return;
  const lines: string[] = [];
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

export function renderVIF(vifValues: number[], xNames: string[]): void {
  const wrap = $('qb-vif-wrap');
  const warnEl = $('qb-vif-warn');
  if (!wrap) return;

  if (!vifValues || vifValues.length === 0) {
    wrap.innerHTML = '<p class="muted" style="font-size:11px">VIF no disponible con un solo predictor.</p>';
    return;
  }

  const warnings: string[] = [];
  let html = '<table class="ledger"><thead><tr><th>Variable</th><th>VIF</th><th>Estado</th></tr></thead><tbody>';
  vifValues.forEach((v, i) => {
    const vStr = !isFinite(v) ? '&gt;999' : v.toFixed(2);
    let cls: string, label: string;
    if (v >= 10) {
      cls = 'qb-vif-high'; label = '⚠ Elevado (heurística)';
      warnings.push(`"${xNames[i]}" (VIF ${!isFinite(v) ? '>999' : v.toFixed(1)}): posible multicolinealidad importante — puede aumentar la imprecisión del coeficiente. Los umbrales 5/10 son reglas prácticas, no tests formales.`);
    } else if (v >= 5) {
      cls = 'qb-vif-med'; label = '△ Moderado (heurística)';
    } else {
      cls = 'qb-vif-ok'; label = '✓ Bajo (orientativo)';
    }
    html += `<tr><td>${escapeHtml(xNames[i])}</td><td>${vStr}</td><td class="${cls}">${label}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  if (warnEl) {
    warnEl.innerHTML = warnings.length > 0
      ? `<div class="qb-warn">${warnings.map(w => `<p>${escapeHtml(w)}</p>`).join('')}</div>`
      : '';
  }
}

// ── Residual diagnostics ──────────────────────────────────────────────────────

export function renderResidDiag(result: RegressionResult): void {
  if (typeof Chart === 'undefined') return;

  const rfCanvas = $('qb-resid-fitted') as HTMLCanvasElement | null;
  if (rfCanvas) {
    if (appState.residFittedChart) { appState.residFittedChart.destroy(); appState.residFittedChart = null; }
    const minP = Math.min(...result.predictions);
    const maxP = Math.max(...result.predictions);
    appState.residFittedChart = new Chart(rfCanvas, {
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
      options: chartTheme('residuos vs ajustados', 'Valor ajustado', 'Residuo', false),
    });
  }

  const histCanvas = $('qb-resid-hist') as HTMLCanvasElement | null;
  if (histCanvas) {
    if (appState.residHistChart) { appState.residHistChart.destroy(); appState.residHistChart = null; }
    const resids = result.residuals;
    const minR = Math.min(...resids), maxR = Math.max(...resids);
    const bins = Math.min(10, Math.max(3, Math.floor(Math.sqrt(resids.length))));
    const bw = (maxR - minR) / bins || 1;
    const counts = new Array(bins).fill(0);
    resids.forEach(r => { const idx = Math.min(Math.floor((r - minR) / bw), bins - 1); counts[idx]++; });
    const labels = Array.from({ length: bins }, (_, i) => (minR + (i + 0.5) * bw).toFixed(2));
    appState.residHistChart = new Chart(histCanvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: counts, backgroundColor: 'rgba(122, 167, 255, .42)', borderColor: '#7aa7ff', borderWidth: 1 }] },
      options: chartTheme('distribución de residuos', 'Residuo', 'Frecuencia', false),
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

// ── Auto-repair log ───────────────────────────────────────────────────────────

const REASON_LABEL: Record<string, string> = {
  perfect_collinearity: 'COLINEALIDAD PERFECTA',
  singular_matrix:      'MATRIZ SINGULAR',
  high_vif:             'VIF ELEVADO',
  insufficient_obs:     'OBS. INSUFICIENTES',
};

export function renderRepairLog(result: AutoRepairResult, rlsFallbackNote = ''): void {
  const el = $('qb-repair-log');
  if (!el) return;

  if (!result.repaired && !rlsFallbackNote) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  const rlsNoteHtml = rlsFallbackNote
    ? `<div class="qb-warn-yellow" style="margin-top:8px"><strong>ℹ Método:</strong> ${escapeHtml(rlsFallbackNote)}</div>`
    : '';

  if (!result.repaired) {
    el.innerHTML = `<div class="qb-repair-log">${rlsNoteHtml}</div>`;
    el.style.display = '';
    return;
  }

  const removed = result.actions.map(a => `<code>${escapeHtml(a.removed)}</code>`).join(', ');
  const kept    = result.finalXNames.map(n => `<code>${escapeHtml(n)}</code>`).join(', ');

  const steps = result.actions.map((a, i) => {
    const valStr = a.valueBefore !== undefined
      ? ` — valor detectado: <strong>${isFinite(a.valueBefore) ? a.valueBefore.toFixed(3) : '>999'}</strong>`
      : '';
    return `
      <div class="qb-repair-step">
        <span class="qb-repair-badge qb-repair-${a.reason}">${REASON_LABEL[a.reason] ?? a.reason}</span>
        <div class="qb-repair-body">
          <strong>Paso ${i + 1}:</strong> eliminada <code>${escapeHtml(a.removed)}</code>${valStr}<br>
          <span class="muted">${escapeHtml(a.detail)}</span>
        </div>
      </div>`;
  }).join('');

  el.innerHTML = `
    <div class="qb-repair-log">
      <div class="qb-panel-head">
        <p class="qb-subtitle">Reparación automática</p>
        <span>DOCTOR DEL MODELO · ${result.actions.length} CORRECCI${result.actions.length !== 1 ? 'ONES' : 'ÓN'}</span>
      </div>
      <div class="qb-warn-yellow" style="margin:8px 0">
        <strong>⚠ El modelo que se calculó es diferente al que solicitaste.</strong><br>
        Modelo solicitado: ${result.originalXNames.map(n => `<code>${escapeHtml(n)}</code>`).join(', ')}<br>
        Variables eliminadas automáticamente: ${removed}<br>
        Modelo final estimado con: ${kept}
      </div>
      <div class="qb-repair-steps">${steps}</div>
      ${rlsNoteHtml}
    </div>`;
  el.style.display = '';
}

// ── Auto-run handler ──────────────────────────────────────────────────────────
