import { rowCountOf, type ParsedCSV } from '../csvParser';
import type { RegressionResult } from '../regression';
import type { LogisticResult } from '../services/analysisService';
import { $ } from '../app/dom';
import { escapeHtml, significanceBadge } from '../utils/format';

export function renderPreview(data: ParsedCSV, labels: ReadonlyMap<string, string> = new Map()): void {
  const { headers, rows, numericColumns } = data;
  const preview = rows.slice(0, 6);
  const thead = `<tr>${headers.map(h => `<th title="${escapeHtml(h)}">${escapeHtml(labels.get(h) ?? h)}</th>`).join('')}</tr>`;
  const tbody = preview
    .map(row => `<tr>${headers.map(h => `<td>${escapeHtml(row[h])}</td>`).join('')}</tr>`)
    .join('');
  const wrap = $('qb-table-wrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger"><thead>${thead}</thead><tbody>${tbody}</tbody></table>
    </div>
    <p class="muted" style="font-size:11px;margin:4px 0 0">
      ${preview.length} de ${rowCountOf(data)} filas · ${headers.length} columnas ·
      <strong>${numericColumns.length} numéricas</strong>
    </p>`;
}


export function renderVarSelectors(cols: string[], categoricalCols: string[] = [], labels: ReadonlyMap<string, string> = new Map()): void {
  const yEl = $('qb-y') as HTMLSelectElement | null;
  const xEl = $('qb-x-checks');
  const categoricalSet = new Set(categoricalCols);
  if (yEl) yEl.innerHTML = cols.map(c => `<option value="${escapeHtml(c)}" title="${escapeHtml(c)}">${escapeHtml(labels.get(c) ?? c)}</option>`).join('');
  const defaultY = cols[0] ?? '';
  if (xEl)
    xEl.innerHTML = cols
      .map((c, i) => {
        const isY = c === defaultY;
        const catBadge = categoricalSet.has(c) ? '<span class="qb-cat-badge" style="opacity:0.6;font-size:11px"> (categórica)</span>' : '';
        return `<label class="qb-x-check" title="${escapeHtml(c)}" style="${isY ? 'opacity:0.4' : ''}"><input type="checkbox" class="qb-x-cb" value="${escapeHtml(c)}" ${i > 0 ? 'checked' : ''} ${isY ? 'disabled title="Ya seleccionada como variable Y"' : ''}> ${escapeHtml(labels.get(c) ?? c)}${catBadge}<span class="qb-y-badge"${isY ? '' : ' style="display:none"'}> (Y)</span></label>`;
      })
      .join('');
}


export function renderLogistic(res: LogisticResult | null): void {
  const wrap = $('qb-logit-wrap');
  const content = $('qb-logit-content');
  if (!wrap || !content) return;
  if (!res) {
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  const f4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '-');
  const rows = res.featureNames
    .map(
      (name, index) =>
        `<tr><td>${escapeHtml(name)}</td><td>${f4(res.coefficients[index])}</td><td>${f4(res.oddsRatios[index])}</td></tr>`
    )
    .join('');

  content.innerHTML = `
    <div class="qb-table-scroll">
      <table class="ledger">
        <thead><tr><th>Variable</th><th>Coef. logístico</th><th>Odds ratio</th></tr></thead>
        <tbody>
          <tr><td>Intercepto</td><td>${f4(res.intercept)}</td><td>${f4(Math.exp(res.intercept))}</td></tr>
          ${rows}
        </tbody>
      </table>
    </div>
    <table class="ledger qb-compact-ledger">
      <thead><tr><th>Métrica</th><th>Valor</th></tr></thead>
      <tbody>
        <tr><td>McFadden pseudo R²</td><td>${res.mcFaddenR2.toFixed(4)}</td></tr>
        <tr><td>Log-verosimilitud del modelo</td><td>${res.llModel.toFixed(4)}</td></tr>
        <tr><td>Log-verosimilitud nula</td><td>${res.llNull.toFixed(4)}</td></tr>
        <tr><td>Precisión en muestra</td><td>${(res.accuracy * 100).toFixed(1)}%</td></tr>
        <tr><td>Observaciones</td><td>${res.n}</td></tr>
      </tbody>
    </table>`;
}

export function renderCoefTable(result: RegressionResult): void {
  const body = $('qb-coef-body');
  if (!body) return;
  const fmt6 = (n: number) => (isFinite(n) ? n.toFixed(6) : '—');
  const fmt4 = (n: number) => (isFinite(n) ? n.toFixed(4) : '—');
  const fmtCI = ([lo, hi]: [number, number]) => `[${fmt4(lo)},&nbsp;${fmt4(hi)}]`;
  const noInf = result.restrictedInferenceAvailable === false;
  const nd = '<span style="opacity:0.4;font-style:italic">N/D</span>';
  body.innerHTML = [
    `<tr>
      <td>Intercepto</td>
      <td>${fmt6(result.intercept)}</td>
      <td>${noInf ? nd : fmt6(result.stdErrors[0])}</td>
      <td>${noInf ? nd : fmt4(result.tStats[0])}</td>
      <td>${noInf ? nd : fmt4(result.pValues[0])}</td>
      <td style="white-space:nowrap">${noInf ? nd : fmtCI(result.ci95[0])}</td>
      <td>${noInf ? nd : significanceBadge(result.pValues[0])}</td>
    </tr>`,
    ...result.featureNames.map(
      (n, i) => `<tr>
        <td>${escapeHtml(n)}</td>
        <td>${fmt6(result.coefficients[i])}</td>
        <td>${noInf ? nd : fmt6(result.stdErrors[i + 1])}</td>
        <td>${noInf ? nd : fmt4(result.tStats[i + 1])}</td>
        <td>${noInf ? nd : fmt4(result.pValues[i + 1])}</td>
        <td style="white-space:nowrap">${noInf ? nd : fmtCI(result.ci95[i + 1])}</td>
        <td>${noInf ? nd : significanceBadge(result.pValues[i + 1])}</td>
      </tr>`
    ),
  ].join('');
}

export function renderStatsTable(result: RegressionResult, dropped: number): void {
  const body = $('qb-stats-body');
  if (!body) return;
  const fmtF = (f: number) => !isFinite(f) ? '∞' : f.toFixed(4);
  body.innerHTML = `
    <tr><td>Método</td><td>${result.method === 'RLS' ? 'RLS' : 'OLS'}</td></tr>
    <tr><td>R²</td><td>${result.rSquared.toFixed(4)}</td></tr>
    <tr><td>R² ajustado</td><td>${result.adjustedRSquared.toFixed(4)}</td></tr>
    <tr><td>F-estadístico</td><td>${fmtF(result.fStat)}</td></tr>
    <tr><td>p(F)</td><td>${result.fPValue.toFixed(4)}</td></tr>
    <tr><td>Observaciones (n)</td><td>${result.nObs}</td></tr>
    <tr><td>Variables (k)</td><td>${result.nFeatures}</td></tr>
    <tr><td>Grados de libertad</td><td>${result.df}</td></tr>
    <tr><td>σ² (var. residual)</td><td>${result.sigma2.toFixed(4)}</td></tr>
    ${dropped > 0 ? `<tr><td>Filas omitidas (NA)</td><td>${dropped}</td></tr>` : ''}`;
}
