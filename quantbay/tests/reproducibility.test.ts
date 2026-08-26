import { describe, expect, it } from 'vitest';
import {
  generateActionSnippet,
  generateNotebook,
  generatePlainScript,
  generateReproducibilityArtifact,
} from '../src/reproducibility/generator';
import type { ReproducibilityAction, ReproducibilitySpec } from '../src/reproducibility/types';

function regressionSpec(): ReproducibilitySpec {
  return {
    schemaVersion: 1,
    generatedAt: '2026-08-26T12:00:00.000Z',
    datasetName: 'datos con espacios.csv',
    mode: 'regression',
    engine: 'pro',
    regression: {
      yName: 'ventas netas',
      xNames: ['precio', 'región'],
      expandedXNames: ['precio', 'region_Sur'],
      functionalForm: 'log-log',
      dropIncompleteRows: true,
      standardErrorType: 'HAC',
      hacMaxLags: 3,
      categoricalEncodings: [{
        source: 'región',
        baseCategory: 'Norte',
        categories: ['Norte', 'Sur'],
        dummyNames: ['region_Sur'],
      }],
      restriction: {
        expression: 'precio = region_Sur',
        R: [[0, 1, -1]],
        q: [0],
      },
      autoRepair: false,
    },
    timeSeries: {
      dateColumn: 'fecha',
      valueColumn: 'ventas netas',
      transformation: 'difference',
      movingAverageWindow: 3,
      maxLag: 12,
      adfRegression: 'c',
      runArima: false,
      arimaOrder: { p: 1, d: 0, q: 1 },
      forecastSteps: 12,
    },
  };
}

describe('reproducibility generator', () => {
  it('generates an executable Python recipe with the exact model decisions', () => {
    const script = generatePlainScript(regressionSpec(), 'python');

    expect(script).toContain('Path("datos con espacios.csv")');
    expect(script).toContain('Y_NAME = "ventas netas"');
    expect(script).toContain('"baseCategory":"Norte"');
    expect(script).toContain('np.log(y)');
    expect(script).toContain('cov_type="HAC"');
    expect(script).toContain('hac_lags_requested = 3');
    expect(script).toContain('"maxlags": hac_lags_used');
    expect(script).toContain('results.f_test((R, q))');
  });

  it('quotes non-syntactic column names in R and preserves the restriction matrix', () => {
    const script = generatePlainScript(regressionSpec(), 'r');

    expect(script).toContain('`ventas netas`');
    expect(script).toContain('log(`precio`)');
    expect(script).toContain('R <- matrix(c(0, 1, -1)');
    expect(script).toContain('car::linearHypothesis');
    expect(script).toContain('vcov. = chartbay_vcov');
  });

  it('produces a Stata do-file with import, dummies and diagnostics', () => {
    const script = generatePlainScript(regressionSpec(), 'stata');

    expect(script).toContain('import delimited using "datos con espacios.csv"');
    expect(script).toContain('generate byte region_Sur');
    expect(script).toContain('regress');
    expect(script).toContain('estat hettest');
    expect(script).toContain('testnl (_b[_cb_x1] = _b[region_Sur])');
    expect(script).not.toContain('constraint define 1');
  });

  it('produces a valid nbformat 4 notebook containing the Python recipe', () => {
    const notebookText = generateNotebook(regressionSpec());
    const notebook = JSON.parse(notebookText);

    expect(notebook.nbformat).toBe(4);
    expect(notebook.cells).toHaveLength(2);
    expect(notebook.cells[1].cell_type).toBe('code');
    expect(notebook.cells[1].source.join('')).toContain('statsmodels.api');
    expect(generateReproducibilityArtifact(regressionSpec(), 'notebook')).toBe(notebookText);
  });

  it('generates time-series recipes with the chosen transformation and ARIMA order', () => {
    const spec = regressionSpec();
    spec.mode = 'timeseries';
    spec.timeSeries.transformation = 'movingAverage';
    spec.timeSeries.movingAverageWindow = 5;
    spec.timeSeries.runArima = true;
    spec.timeSeries.arimaOrder = { p: 2, d: 1, q: 1 };

    expect(generatePlainScript(spec, 'python')).toContain('rolling(5)');
    expect(generatePlainScript(spec, 'python')).toContain('order=(2, 1, 1)');
    expect(generatePlainScript(spec, 'python')).toContain('.set_index("fecha")');
    expect(generatePlainScript(spec, 'python')).toContain('pd.infer_freq(series.index)');
    expect(generatePlainScript(spec, 'r')).toContain('order = c(2, 1, 1)');
    expect(generatePlainScript(spec, 'stata')).toContain('arima(2,1,1)');
    expect(generatePlainScript(spec, 'stata')).toContain('tsappend, add(12)');
    expect(generatePlainScript(spec, 'stata')).toContain("dynamic(`_cb_forecast_start')");
  });

  it('recomputes the Lite RLS fit and diagnostics instead of reporting unrestricted OLS', () => {
    const spec = regressionSpec();
    spec.engine = 'lite';
    spec.regression.functionalForm = 'lin-lin';
    spec.regression.standardErrorType = 'classic';

    const python = generatePlainScript(spec, 'python');
    expect(python).toContain('predictions = X_matrix @ beta_restricted');
    expect(python).toContain('residuals = y_values - predictions');
    expect(python).toContain('"method": "RLS"');
    expect(python).toContain('het_breuschpagan(residuals, X_matrix)');
    expect(python).not.toContain('print(results.summary())');

    const r = generatePlainScript(spec, 'r');
    expect(r).toContain('predictions_restricted <- drop(X_matrix %*% beta_restricted)');
    expect(r).toContain('residuals_squared <- residuals_restricted^2');
    expect(r).not.toContain('print(summary(fit))');

    const stata = generatePlainScript(spec, 'stata');
    expect(stata).toContain('cnsreg ventas_netas precio region_Sur, constraints(1)');
    expect(stata).toContain('predict double _cb_residual, residuals');
    expect(stata).toContain('Breusch-Pagan LM');
  });

  it('preserves automatic HAC lag selection across Python, R and Stata', () => {
    const spec = regressionSpec();
    spec.regression.hacMaxLags = null;

    expect(generatePlainScript(spec, 'python')).toContain('hac_lags_requested = None');
    expect(generatePlainScript(spec, 'r')).toContain('floor(4 * (nobs(fit) / 100)^(2 / 9))');
    expect(generatePlainScript(spec, 'stata')).toContain('floor(4 * (e(N) / 100)^(2 / 9))');
  });

  it('shows each action as syntax in the selected language', () => {
    const action: ReproducibilityAction = {
      id: 1,
      timestamp: '2026-08-26T12:00:00.000Z',
      label: 'Seleccionar variables X',
      spec: regressionSpec(),
    };

    expect(generateActionSnippet(action, 'python')).toContain('x_names = ["precio","región"]');
    expect(generateActionSnippet(action, 'r')).toContain('fit <- lm');
    expect(generateActionSnippet(action, 'stata')).toContain('regress');
  });
});
