"""Validación matemática de RLS/Wald contra una referencia NumPy/SciPy independiente."""

import math

import numpy as np
import pytest
from scipy.stats import f as f_dist

from chartbay_engine.core.econometrics.regression.rls import LinearConstraint, run_rls
from chartbay_engine.core.errors import ConstraintError


def make_dataset(seed: int, n: int, k: int, noise: float = 0.25):
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


def numpy_rls_reference(X, y, R, q) -> dict:
    """RLS por ecuaciones normales (algoritmo distinto al QR del motor: oráculo real)."""
    X = np.asarray(X, float)
    y = np.asarray(y, float)
    R = np.asarray(R, float)
    q = np.asarray(q, float)
    n, k = X.shape
    Xd = np.column_stack([np.ones(n), X])
    XtXinv = np.linalg.inv(Xd.T @ Xd)
    beta_ols = XtXinv @ Xd.T @ y
    rss_ols = float(((y - Xd @ beta_ols) ** 2).sum())
    middle = np.linalg.inv(R @ XtXinv @ R.T)
    beta = beta_ols - XtXinv @ R.T @ middle @ (R @ beta_ols - q)
    fitted = Xd @ beta
    resid = y - fitted
    rss_rls = float((resid**2).sum())
    ss_tot = float(((y - y.mean()) ** 2).sum())
    df = n - k - 1
    j = R.shape[0]
    r2 = 1.0 - rss_rls / ss_tot
    adj = 1.0 - (1.0 - r2) * (n - 1) / df
    fc = ((rss_rls - rss_ols) / j) / (rss_ols / df) if (df > 0 and rss_ols > 1e-15) else 0.0
    fp = float(f_dist.sf(max(0.0, fc), j, df)) if df > 0 else 1.0
    return {
        "beta": beta, "fitted": fitted, "resid": resid, "rss_ols": rss_ols,
        "rss_rls": rss_rls, "r2": r2, "adj": adj, "fc": fc, "fp": fp,
    }


# (seed, k, R, q, label) — las tres restricciones obligatorias.
CASES = [
    (101, 1, [[0, 1]], [0.0], "beta1 = 0"),
    (102, 2, [[0, 1, -1]], [0.0], "beta1 = beta2"),
    (103, 2, [[0, 1, 1]], [1.0], "beta1 + beta2 = 1"),
]


@pytest.mark.parametrize(("seed", "k", "R", "q", "label"), CASES)
def test_rls_matches_numpy_reference(seed, k, R, q, label):
    X, y = make_dataset(seed, 30, k)
    names = [f"x{i + 1}" for i in range(k)]
    res = run_rls(X, y, names, "y", constraint=LinearConstraint(R=R, q=q, label=label))
    ref = numpy_rls_reference(X, y, R, q)

    beta = [res.intercept, *res.coefficients]
    np.testing.assert_allclose(beta, ref["beta"], rtol=1e-8, atol=1e-9)
    np.testing.assert_allclose(res.predictions, ref["fitted"], rtol=1e-8, atol=1e-9)
    np.testing.assert_allclose(res.residuals, ref["resid"], rtol=1e-8, atol=1e-9)
    assert res.rss_ols == pytest.approx(ref["rss_ols"], rel=1e-8)
    assert res.rss_rls == pytest.approx(ref["rss_rls"], rel=1e-8)
    assert res.r_squared == pytest.approx(ref["r2"], rel=1e-8)
    assert res.adjusted_r_squared == pytest.approx(ref["adj"], rel=1e-8)
    assert res.f_stat_constraint == pytest.approx(ref["fc"], rel=1e-7, abs=1e-9)
    assert res.f_p_value_constraint == pytest.approx(ref["fp"], rel=1e-7, abs=1e-12)

    assert res.method == "RLS"
    assert res.rls_constraint == label
    assert res.j_constraints == len(R)
    assert res.restricted_inference_available is True
    assert all(np.isfinite(res.std_errors))


def test_rls_beta1_zero_sets_slope_to_zero():
    X, y = make_dataset(77, 30, 1)
    res = run_rls(X, y, ["x"], "y", constraint=LinearConstraint([[0, 1]], [0.0], "beta1=0"))
    assert res.coefficients[0] == pytest.approx(0.0, abs=1e-9)


def test_rls_beta1_equals_beta2():
    X, y = make_dataset(78, 40, 2)
    res = run_rls(
        X, y, ["x1", "x2"], "y", constraint=LinearConstraint([[0, 1, -1]], [0.0], "b1=b2")
    )
    assert res.coefficients[0] == pytest.approx(res.coefficients[1], abs=1e-9)


def test_rls_sum_equals_one():
    X, y = make_dataset(79, 40, 2)
    res = run_rls(
        X, y, ["x1", "x2"], "y", constraint=LinearConstraint([[0, 1, 1]], [1.0], "sum=1")
    )
    assert (res.coefficients[0] + res.coefficients[1]) == pytest.approx(1.0, abs=1e-9)


def test_rls_invalid_dimension_raises():
    X, y = make_dataset(11, 30, 2)
    names = ["x1", "x2"]
    # fila R con largo incorrecto (2 columnas para un modelo de 3 parámetros)
    with pytest.raises(ConstraintError):
        run_rls(X, y, names, "y", constraint=LinearConstraint([[0, 1]], [0.0], "bad row"))
    # q con largo distinto a J
    with pytest.raises(ConstraintError):
        run_rls(X, y, names, "y", constraint=LinearConstraint([[0, 1, -1]], [], "bad q"))
    # más restricciones que parámetros (J=4 > 3)
    with pytest.raises(ConstraintError):
        run_rls(
            X, y, names, "y",
            constraint=LinearConstraint(
                [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]], [0, 0, 0, 0], "too many"
            ),
        )
    # restricción vacía
    with pytest.raises(ConstraintError):
        run_rls(X, y, names, "y", constraint=LinearConstraint([], [], "empty"))


def test_rls_singular_constraint_raises():
    X, y = make_dataset(12, 30, 2)
    with pytest.raises(ConstraintError) as exc:
        run_rls(
            X, y, ["x1", "x2"], "y",
            constraint=LinearConstraint([[0, 1, -1], [0, 2, -2]], [0.0, 0.0], "redundant"),
        )
    assert exc.value.code == "singular_constraint"
    msg = str(exc.value).lower()
    assert "singular" in msg or "colineal" in msg


def test_rls_perfect_fit_reports_infinite_overall_f():
    X = [[float(i)] for i in range(1, 7)]
    y = [2.0 * i + 1.0 for i in range(1, 7)]  # ajuste exacto; restricción cierta
    res = run_rls(X, y, ["x"], "y", constraint=LinearConstraint([[0, 1]], [2.0], "beta1=2"))
    assert res.r_squared == pytest.approx(1.0, abs=1e-9)
    assert math.isinf(res.f_stat) or res.f_stat > 1e10
    assert res.f_p_value == pytest.approx(0.0, abs=1e-9)
