import { describe, expect, it, beforeEach } from 'vitest';
import { renderRegressionResults } from '../src/ui/regressionView';
import { runRLS } from '../src/rls';

function installRegressionDom(): void {
  document.body.innerHTML = `
    <div id="qb-binary-warn"></div>
    <div id="qb-leak-warn"></div>
    <div id="qb-equation"></div>
    <table><tbody id="qb-coef-body"></tbody></table>
    <table><tbody id="qb-stats-body"></tbody></table>
    <div id="qb-rls-panel"><div id="qb-rls-content"></div></div>
    <div id="qb-logit-wrap"><div id="qb-logit-content"></div></div>
    <canvas id="qb-chart"></canvas>
    <div id="qb-corr-wrap"></div>
    <div id="qb-corr-interp"></div>
    <div id="qb-vif-wrap"></div>
    <div id="qb-vif-warn"></div>
    <canvas id="qb-resid-fitted"></canvas>
    <canvas id="qb-resid-hist"></canvas>
    <div id="qb-resid-stats"></div>
    <div id="qb-interpretation"></div>
    <div id="qb-pred-table"></div>
  `;
}

describe('renderRegressionResults RLS outputs', () => {
  beforeEach(() => installRegressionDom());

  it('renders RLS coefficients, fit stats, restriction test, and interpretation from the validated result', () => {
    const X = [[1, 3], [2, 1], [3, 4], [4, 2], [5, 5], [6, 1], [7, 3], [8, 2], [9, 4], [10, 1]];
    const y = X.map(([x1, x2], index) => 1 + 0.7 * x1 + 0.3 * x2 + (index % 3) * 0.04);
    const result = runRLS(
      { X, y, featureNames: ['x1', 'x2'], yName: 'y' },
      { R: [[0, 1, 1]], q: [1], label: 'beta1 + beta2 = 1' }
    );

    renderRegressionResults(result, 0, [[1, 0.2], [0.2, 1]], ['x1', 'x2'], [1.2, 1.2]);

    const coefText = document.querySelector('#qb-coef-body')?.textContent ?? '';
    const statsText = document.querySelector('#qb-stats-body')?.textContent ?? '';
    const rlsText = document.querySelector('#qb-rls-content')?.textContent ?? '';
    const interpretation = document.querySelector('#qb-interpretation')?.textContent ?? '';

    expect(coefText).toContain(result.intercept.toFixed(6));
    expect(coefText).toContain(result.coefficients[0].toFixed(6));
    expect(coefText).toContain(result.coefficients[1].toFixed(6));
    expect(statsText).toContain('RLS');
    expect(statsText).toContain(result.rSquared.toFixed(4));
    expect(statsText).toContain(result.adjustedRSquared.toFixed(4));
    expect(rlsText).toContain('beta1 + beta2 = 1');
    expect(rlsText).toContain((result.rssOLS ?? 0).toFixed(6));
    expect(rlsText).toContain((result.rssRLS ?? 0).toFixed(6));
    expect(rlsText).toContain((result.fStatConstraint ?? 0).toFixed(4));
    expect(rlsText).toContain((result.fPValueConstraint ?? 0).toFixed(4));
    expect(interpretation).toContain('RLS');
    expect(interpretation).toContain('beta1 + beta2 = 1');
  });
});
