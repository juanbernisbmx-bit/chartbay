import type { RegressionResult } from '../regression';
import type { LeakageSignal, LogisticResult } from '../services/analysisService';
import type { FunctionalForm } from '../functionalForms';
import type { CategoricalVariableInfo } from '../categoricalEncoding';
import { interpret } from '../interpretation';
import { $ } from '../app/dom';
import { appState } from '../app/state';
import { escapeHtml } from '../utils/format';
import { renderCoefTable, renderLogistic, renderStatsTable } from './tables';
import { chartTheme, renderBinaryWarn, renderCorrMatrix, renderLeakageWarn, renderResidDiag, renderVIF } from './diagnosticsView';

declare const Chart: any;

export function renderRegressionResults(
  result: RegressionResult,
  dropped: number,
  corrMatrix: number[][],
  corrCols: string[],
  vifValues: number[],
  checks: {
    binary?: boolean;
    leaks?: LeakageSignal[];
    logitResult?: LogisticResult | null;
    functionalForm?: FunctionalForm;
    categoricalInfo?: CategoricalVariableInfo[];
    categoricalWarnings?: string[];
  } = {}
): void {
  const {
    binary = false,
    leaks = [],
    logitResult = null,
    functionalForm = 'lin-lin',
    categoricalInfo = [],
    categoricalWarnings = [],
  } = checks;
  appState.lastDropped = dropped;
  renderBinaryWarn(binary, result.yName);
  renderLeakageWarn(leaks);
  const eq = $('qb-equation');
  if (eq) eq.textContent = result.equation;

  renderFunctionalFormNote(functionalForm);
  renderCategoricalNote(categoricalInfo, categoricalWarnings);
  renderCoefTable(result);
  renderStatsTable(result, dropped);
  renderRLSPanel(result);
  renderLogistic(logitResult);
  renderChart(result);
  renderCorrMatrix(corrMatrix, corrCols);
  renderVIF(vifValues, result.featureNames);
  renderResidDiag(result);

  const interp = $('qb-interpretation');
  if (interp) interp.textContent = interpret(result);

  const actual = result.predictions.map((p, i) => p + result.residuals[i]);
  const predTable = $('qb-pred-table');
    if (predTable)
    predTable.innerHTML = `
      <table class="ledger" style="margin-top:8px">
        <thead><tr><th>#</th><th>Real</th><th>Predicho</th><th>Residuo</th></tr></thead>
        <tbody>${result.predictions
          .map(
            (p, i) =>
              `<tr><td>${i + 1}</td><td>${actual[i].toFixed(4)}</td><td>${p.toFixed(4)}</td><td>${result.residuals[i].toFixed(4)}</td></tr>`
          )
          .join('')}</tbody>
      </table>`;
}

function renderFunctionalFormNote(form: FunctionalForm): void {
  const el = $('qb-form-note');
  if (!el) return;
  const notes: Record<FunctionalForm, string> = {
    'lin-lin': '',
    'log-lin': 'Modelo log-lin: Y está en logaritmos. Cada β es una semi-elasticidad — un incremento unitario en X cambia Y en ≈ 100·β%. Efecto exacto: 100·(e^β − 1)%.',
    'lin-log': 'Modelo lin-log: los regresores están en logaritmos. Cada β mide el cambio en Y ante un incremento del 1% en X, en ≈ β/100 unidades.',
    'log-log': 'Modelo log-log: Y y los regresores están en logaritmos. Cada β es una elasticidad — un incremento del 1% en X cambia Y en ≈ β%.',
  };
  const note = notes[form];
  el.textContent = note;
  el.style.display = note ? '' : 'none';
}

function renderCategoricalNote(info: CategoricalVariableInfo[], warnings: string[]): void {
  const el = $('qb-categorical-note');
  if (!el) return;
  if (info.length === 0 && warnings.length === 0) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }

  let html = '';
  if (info.length > 0) {
    html += `<p class="qb-label" style="margin-bottom:4px">Variables categóricas detectadas</p>`;
    html += info
      .map(
        c => `<p class="qb-interp" style="margin:0 0 4px;font-size:12px">
          <strong>${escapeHtml(c.originalName)}</strong> &mdash;
          categoría base: <code>${escapeHtml(c.baseCategory)}</code> &middot;
          dummies creadas: ${c.createdDummies.map(d => `<code>${escapeHtml(d)}</code>`).join(', ')}
        </p>`
      )
      .join('');
    html += `<p class="muted" style="font-size:11px;margin:2px 0 8px">Cada coeficiente dummy mide la diferencia estimada contra la categoría base, manteniendo constantes las demás variables.</p>`;
  }
  if (warnings.length > 0) {
    html += warnings
      .map(w => `<p class="qb-interp" style="margin:0 0 4px;font-size:12px;color:#f2c94c">${escapeHtml(w)}</p>`)
      .join('');
  }

  el.innerHTML = html;
  el.style.display = '';
}

function renderRLSPanel(result: RegressionResult): void {
  const panel = $('qb-rls-panel');
  const content = $('qb-rls-content');
  if (!panel || !content) return;

  if (result.method !== 'RLS') {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = '';
  const f4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '—');
  const pVal = result.fPValueConstraint ?? 1;
  const rejected = pVal < 0.05;
  const verdict = rejected
    ? `Restricción <strong>rechazada</strong> (p = ${f4(pVal)} &lt; 0.05): los datos no son estadísticamente compatibles con la restricción al 5%.`
    : `Restricción <strong>no rechazada</strong> (p = ${f4(pVal)} ≥ 0.05): los datos son estadísticamente compatibles con la restricción al 5%.`;

  content.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger">
        <thead><tr><th>Indicador</th><th>Valor</th></tr></thead>
        <tbody>
          <tr><td>Restricción aplicada</td><td><strong>${escapeHtml(result.rlsConstraint ?? '')}</strong></td></tr>
          <tr><td>RSS sin restricción (OLS)</td><td>${(result.rssOLS ?? 0).toFixed(6)}</td></tr>
          <tr><td>RSS con restricción (RLS)</td><td>${(result.rssRLS ?? 0).toFixed(6)}</td></tr>
          <tr><td>F-test restricción</td><td>${f4(result.fStatConstraint ?? 0)}</td></tr>
          <tr><td>p-valor (F-test)</td><td>${f4(pVal)}</td></tr>
          <tr><td>Restricciones (J)</td><td>${result.jConstraints ?? 1}</td></tr>
        </tbody>
      </table>
    </div>
    <p class="qb-interp" style="margin-top:8px">${verdict}</p>`;
}

function renderChart(result: RegressionResult): void {
  const canvas = $('qb-chart') as HTMLCanvasElement | null;
  if (appState.activeChart) { appState.activeChart.destroy(); appState.activeChart = null; }
  if (typeof Chart === 'undefined' || !canvas) return;

  const actual = result.predictions.map((p, i) => p + result.residuals[i]);
  const allV = [...actual, ...result.predictions];
  const minV = Math.min(...allV), maxV = Math.max(...allV);
  const pad = (maxV - minV) * 0.05 || 1;

  appState.activeChart = new Chart(canvas, {
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
    options: chartTheme(`${result.yName}: actual vs predicho`, `Actual (${result.yName})`, `Predicho (${result.yName})`),
  });
}

// ── Correlation matrix ────────────────────────────────────────────────────────
