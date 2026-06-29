"""Validación de ACF/PACF/Ljung-Box contra statsmodels."""

import numpy as np
import pytest
from statsmodels.stats.diagnostic import acorr_ljungbox
from statsmodels.tsa.stattools import acf, pacf

from chartbay_engine.core.econometrics.time_series.autocorrelation import run_autocorrelation


def ar_series(seed: int, n: int, phi: float) -> list[float]:
    rng = np.random.default_rng(seed)
    e = rng.normal(0.0, 1.0, n)
    x = np.empty(n)
    x[0] = e[0]
    for t in range(1, n):
        x[t] = phi * x[t - 1] + e[t]
    return x.tolist()


def test_acf_matches_statsmodels():
    x = ar_series(5, 150, 0.6)
    res = run_autocorrelation(x, 12)
    ref = acf(np.asarray(x), nlags=12, adjusted=False, fft=False)[1:]
    ours = [row.autocorrelation for row in res.rows]
    np.testing.assert_allclose(ours, ref, rtol=1e-10, atol=1e-12)


def test_pacf_matches_statsmodels_levinson_durbin_biased():
    x = ar_series(6, 150, 0.5)
    res = run_autocorrelation(x, 12)
    ref = pacf(np.asarray(x), nlags=12, method="ldbiased")[1:]
    ours = [p.partial_autocorrelation for p in res.pacf]
    np.testing.assert_allclose(ours, ref, rtol=1e-8, atol=1e-10)


def test_ljung_box_matches_statsmodels():
    x = ar_series(7, 200, 0.4)
    res = run_autocorrelation(x, 20)
    ref = acorr_ljungbox(np.asarray(x), lags=[5, 10, 20], return_df=True)
    for entry in res.ljung_box:
        assert entry.q_statistic == pytest.approx(float(ref.loc[entry.lag, "lb_stat"]), rel=1e-8)
        assert entry.p_value == pytest.approx(
            float(ref.loc[entry.lag, "lb_pvalue"]), rel=1e-7, abs=1e-15
        )


def test_threshold_and_outside_flags():
    x = ar_series(8, 100, 0.7)
    res = run_autocorrelation(x, 10)
    assert res.threshold == pytest.approx(1.96 / np.sqrt(res.observations))
    for row in res.rows:
        assert row.outside_threshold == (abs(row.autocorrelation) > res.threshold)


def test_constant_series_returns_warning_and_empty_rows():
    res = run_autocorrelation([3.0] * 40, 10)
    assert res.rows == []
    assert res.pacf == []
    assert any("constant" in w.lower() for w in res.warnings)


def test_insufficient_observations_returns_empty():
    res = run_autocorrelation([1.0, 2.0, 1.5], 5)  # n = 3 < 4
    assert res.rows == []
    assert res.max_lag == 0
    assert res.warnings


def test_max_lag_is_clamped_to_sample():
    res = run_autocorrelation(ar_series(9, 20, 0.3), 50)  # pide 50 con n=20
    assert res.max_lag <= (20 - 1) // 2
    assert any("max lag" in w.lower() for w in res.warnings)
