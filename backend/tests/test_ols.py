"""Validación matemática de OLS contra statsmodels (oráculo independiente, ADR-1)."""

import numpy as np
import pytest
import statsmodels.api as sm

from chartbay_engine.core.econometrics.diagnostics.collinearity import compute_vif
from chartbay_engine.core.econometrics.regression.ols import run_ols
from chartbay_engine.core.errors import (
    InsufficientObservationsError,
    RankDeficiencyError,
)


def make_dataset(seed: int, n: int, k: int, noise: float = 0.25):
    """Dataset lineal con tendencia leve en X (replica el generador del motor TS)."""
    rng = np.random.default_rng(seed)
    beta = rng.uniform(-3, 3, size=k + 1)
    beta[0] = rng.uniform(-2, 2)
    X = (
        rng.uniform(-4, 4, size=(n, k))
        + 0.07 * np.arange(n)[:, None]
        + 0.13 * np.arange(k)[None, :]
    )
    y = beta[0] + X @ beta[1:] + rng.uniform(-noise, noise, size=n)
    return X, y


def sm_fit(X, y):
    return sm.OLS(np.asarray(y), sm.add_constant(np.asarray(X), has_constant="add")).fit()


CASES = [(10_000 + i, 1 + (i % 4) + 8 + (i % 9), 1 + (i % 4)) for i in range(24)]


@pytest.mark.parametrize(("seed", "n", "k"), CASES)
def test_ols_matches_statsmodels(seed, n, k):
    X, y = make_dataset(seed, n, k)
    names = [f"x{i + 1}" for i in range(k)]
    res = run_ols(X, y, names, "y")
    ref = sm_fit(X, y)

    params = [res.intercept, *res.coefficients]
    np.testing.assert_allclose(params, ref.params, rtol=1e-9, atol=1e-9)
    np.testing.assert_allclose(res.predictions, ref.fittedvalues, rtol=1e-9, atol=1e-9)
    np.testing.assert_allclose(res.residuals, ref.resid, rtol=1e-9, atol=1e-9)
    assert res.rss == pytest.approx(float(ref.ssr), rel=1e-9)
    assert res.r_squared == pytest.approx(float(ref.rsquared), rel=1e-9)
    assert res.adjusted_r_squared == pytest.approx(float(ref.rsquared_adj), rel=1e-9)
    np.testing.assert_allclose(res.std_errors, ref.bse, rtol=1e-8, atol=1e-9)
    np.testing.assert_allclose(res.t_stats, ref.tvalues, rtol=1e-8, atol=1e-9)
    np.testing.assert_allclose(res.p_values, ref.pvalues, rtol=1e-6, atol=1e-9)
    assert res.f_stat == pytest.approx(float(ref.fvalue), rel=1e-8)
    assert res.f_p_value == pytest.approx(float(ref.f_pvalue), rel=1e-6, abs=1e-12)
    assert res.df == int(ref.df_resid)
    assert res.n_obs == n and res.n_features == k


def test_ci95_brackets_coefficients():
    X, y = make_dataset(777, 40, 2)
    res = run_ols(X, y, ["x1", "x2"], "y")
    params = [res.intercept, *res.coefficients]
    for (lo, hi), b in zip(res.ci95, params, strict=True):
        assert lo <= b <= hi


def test_outputs_are_native_floats_json_safe():
    X, y = make_dataset(5, 20, 2)
    res = run_ols(X, y, ["x1", "x2"], "y")
    assert all(isinstance(c, float) for c in res.coefficients)
    assert all(np.isfinite(res.std_errors))
    assert isinstance(res.rss, float)


def test_perfect_collinearity_raises():
    X = [[float(i), float(2 * i)] for i in range(1, 9)]  # x2 = 2*x1
    y = [float(i) for i in range(1, 9)]
    with pytest.raises(RankDeficiencyError) as exc:
        run_ols(X, y, ["x1", "x2"], "y")
    assert exc.value.code == "rank_deficiency"
    assert exc.value.details["issues"]


def test_constant_predictor_raises_against_intercept():
    X = [[float(i), 5.0] for i in range(1, 9)]  # segunda columna constante
    y = [2.0 * i for i in range(1, 9)]
    with pytest.raises(RankDeficiencyError) as exc:
        run_ols(X, y, ["x", "const"], "y")
    msg = str(exc.value).lower()
    assert "constante" in msg or "varianza cero" in msg or "intercepto" in msg


def test_insufficient_observations_raises():
    with pytest.raises(InsufficientObservationsError):
        run_ols([[1.0], [2.0]], [1.0, 2.0], ["x"], "y")


def test_drop_redundant_recovers_clean_model():
    X_base, y = make_dataset(99, 30, 2)
    # Inserta una columna duplicada de x1 entre x1 y x2.
    X = np.column_stack([X_base[:, 0], X_base[:, 0], X_base[:, 1]])
    res = run_ols(X, y, ["x1", "x1_dup", "x2"], "y", drop_redundant=True)

    assert res.dropped_features is not None
    assert any("x1_dup" in d.name for d in res.dropped_features)
    assert res.feature_names == ["x1", "x2"]

    ref = sm_fit(X_base, y)  # modelo limpio equivalente
    np.testing.assert_allclose(
        [res.intercept, *res.coefficients], ref.params, rtol=1e-8, atol=1e-9
    )


def test_compute_vif_flags_collinearity():
    X_base, _ = make_dataset(7, 60, 2)
    X = np.column_stack([X_base[:, 0], X_base[:, 1], X_base[:, 0] + X_base[:, 1]])
    vifs = compute_vif(X)
    assert len(vifs) == 3
    assert max(vifs) > 100  # la tercera columna es combinación lineal exacta
