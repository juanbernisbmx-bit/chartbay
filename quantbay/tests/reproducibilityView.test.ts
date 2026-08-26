import { beforeEach, describe, expect, it } from 'vitest';
import { appState } from '../src/app/state';
import type { RegressionResult } from '../src/regression';
import {
  captureReproducibilitySpec,
  markReproducibilityExecuted,
  resetReproducibilityForDataset,
} from '../src/ui/reproducibilityView';

beforeEach(() => {
  document.body.innerHTML = `
    <section id="qb-repro-panel">
      <p id="qb-repro-status"></p>
      <pre><code id="qb-repro-code"></code></pre>
      <div id="qb-repro-history"></div>
      <button data-repro-download="r"></button>
      <button data-repro-download="python"></button>
      <button data-repro-download="stata"></button>
      <button data-repro-download="notebook"></button>
    </section>
    <select id="qb-y"><option value="y" selected>y</option></select>
    <input class="qb-x-cb" type="checkbox" value="x1" checked>
    <input class="qb-x-cb" type="checkbox" value="x2" checked>
    <input id="qb-rls-input" value="x2 = 0">
    <input id="qb-drop-incomplete" type="checkbox" checked>
  `;
  appState.datasetName = 'datos.csv';
  appState.activeMode = 'regression';
  appState.activeVersion = 'lite';
  appState.activeFunctionalForm = 'lin-lin';
  appState.lastCategoricalInfo = [];
  appState.lastResult = null;
  resetReproducibilityForDataset('datos.csv');
});

describe('reproducibility execution state', () => {
  it('keeps an auto-repaired OLS recipe executed and removes the rejected RLS restriction', () => {
    appState.lastResult = {
      featureNames: ['x1'],
      method: 'OLS',
    } as RegressionResult;

    markReproducibilityExecuted('Regresión OLS reparada y ejecutada', true);

    const status = document.getElementById('qb-repro-status');
    const code = document.getElementById('qb-repro-code')?.textContent ?? '';
    const executed = captureReproducibilitySpec(true);

    expect(status?.textContent).toBe('RECETA EJECUTADA · LISTA PARA DESCARGAR');
    expect(status?.dataset.state).toBe('executed');
    expect(executed.regression.expandedXNames).toEqual(['x1']);
    expect(executed.regression.restriction).toBeNull();
    expect(code).toContain('EXPANDED_X_NAMES = ["x1"]');
    expect(code).not.toContain('beta_restricted');
  });

  it('exports the effective RLS constraint used by a demo even when the text field is empty', () => {
    (document.getElementById('qb-rls-input') as HTMLInputElement).value = '';
    appState.lastResult = {
      featureNames: ['x1', 'x2'],
      method: 'RLS',
    } as RegressionResult;

    markReproducibilityExecuted('Regresión RLS ejecutada', false, {
      label: 'x2 = 0',
      R: [[0, 0, 1]],
      q: [0],
    });

    const code = document.getElementById('qb-repro-code')?.textContent ?? '';
    expect(document.getElementById('qb-repro-status')?.textContent)
      .toBe('RECETA EJECUTADA · LISTA PARA DESCARGAR');
    expect(code).toContain('R = np.asarray([[0,0,1]], dtype=float)');
    expect(code).toContain('beta_restricted');
  });
});
