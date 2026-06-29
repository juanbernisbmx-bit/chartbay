"""Validación del test ADF contra statsmodels.tsa.stattools.adfuller."""

import numpy as np
import pytest
from statsmodels.tsa.stattools import adfuller

from chartbay_engine.core.econometrics.time_series.stationarity import run_adf
from chartbay_engine.core.errors import InvalidInputError


def ar1_series(seed: int, n: int, phi: float, sigma: float = 1.0) -> list[float]:
    rng = np.random.default_rng(seed)
    e = rng.normal(0.0, sigma, n)
    x = np.empty(n)
    x[0] = e[0]
    for t in range(1, n):
        x[t] = phi * x[t - 1] + e[t]
    return x.tolist()


def random_walk(seed: int, n: int, sigma: float = 1.0) -> list[float]:
    rng = np.random.default_rng(seed)
    return np.cumsum(rng.normal(0.0, sigma, n)).tolist()


@pytest.mark.parametrize("lag", [0, 1, 4, 8])
def test_adf_statistic_matches_adfuller_fixed_lag(lag):
    x = ar1_series(1, 200, phi=0.5)
    res = run_adf(x, lag=lag)
    # adfuller con autolag=None devuelve 5 valores (sin icbest).
    stat, pval, usedlag, _nobs, crit = adfuller(
        np.asarray(x), maxlag=lag, regression="c", autolag=None
    )

    assert res.available is True
    assert res.used_lag == lag == usedlag
    assert res.statistic == pytest.approx(float(stat), rel=1e-7, abs=1e-7)
    assert res.p_value == pytest.approx(float(pval), rel=1e-6, abs=1e-9)
    assert res.critical_values.one_percent == pytest.approx(crit["1%"], rel=1e-6)
    assert res.critical_values.five_percent == pytest.approx(crit["5%"], rel=1e-6)
    assert res.critical_values.ten_percent == pytest.approx(crit["10%"], rel=1e-6)
    assert 0.0 <= res.p_value <= 1.0


def test_adf_auto_lag_matches_adfuller_with_same_lag():
    x = ar1_series(2, 250, phi=0.4)
    res = run_adf(x)  # lag automático (Schwert)
    assert res.available is True
    stat, *_ = adfuller(np.asarray(x), maxlag=res.used_lag, regression="c", autolag=None)
    assert res.statistic == pytest.approx(float(stat), rel=1e-7, abs=1e-7)
    assert 0.0 <= res.p_value <= 1.0


def test_adf_detects_stationary_ar1():
    x = ar1_series(7, 300, phi=0.2)  # fuertemente estacionaria
    res = run_adf(x, lag=1)
    assert res.available is True
    assert res.is_stationary is True
    assert res.p_value < 0.05


def test_adf_detects_random_walk_nonstationary():
    x = random_walk(1, 300)  # seed verificado: p-valor ~0.95, claramente no estacionario
    res = run_adf(x, lag=1)
    assert res.available is True
    assert res.is_stationary is False
    assert res.p_value > 0.05


def test_adf_constant_series_unavailable():
    res = run_adf([5.0] * 50)
    assert res.available is False
    assert res.statistic is None
    assert res.reason and "constante" in res.reason.lower()


def test_adf_insufficient_observations_unavailable():
    res = run_adf([1.0, 2.0, 1.5, 2.5, 1.8])  # n = 5 < 8
    assert res.available is False
    assert res.n_obs == 5
    assert res.reason


def test_adf_negative_lag_raises():
    x = ar1_series(3, 60, phi=0.3)
    with pytest.raises(InvalidInputError):
        run_adf(x, lag=-1)


def test_adf_pvalue_within_unit_interval_across_series():
    for seed, phi in [(11, 0.0), (12, 0.5), (13, 0.9)]:
        res = run_adf(ar1_series(seed, 180, phi=phi), lag=2)
        assert res.available is True
        assert 0.0 <= res.p_value <= 1.0
