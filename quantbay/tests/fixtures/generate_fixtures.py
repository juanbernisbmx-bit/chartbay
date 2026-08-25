#!/usr/bin/env python3
"""Generate reference fixtures for the ChartBay TypeScript math engine.

These JSON files are committed to the repository so the TypeScript test suite
can validate the engine against trusted Python references (statsmodels / numpy /
scipy / pandas) WITHOUT requiring Python to be installed at test time.

Usage (from the quantbay/ directory):

    python tests/fixtures/generate_fixtures.py

Regenerate the fixtures whenever you intentionally change a reference dataset.
The numbers come from:
  - statsmodels.OLS                              -> OLS coefficients / inference
  - explicit matrix algebra + scipy.stats.f      -> restricted least squares (RLS)
  - statsmodels.tsa.stattools.acf / pacf         -> autocorrelation
  - statsmodels.stats.diagnostic.acorr_ljungbox  -> Ljung-Box Q
  - statsmodels.tsa.stattools.adfuller           -> Augmented Dickey-Fuller
  - pandas / numpy                               -> diff / pct_change / log returns

Conventions chosen to match the TypeScript engine exactly:
  - ACF/PACF use the BIASED estimator (statsmodels adjusted=False / method='ldb'),
    because src/timeseries/acf.ts divides by the full sum of squared deviations.
  - ACF/PACF fixtures store lags 1..maxLag (lag 0 == 1 is dropped, as ChartBay does).
  - ADF uses regression='c' (constant, no trend) with a FIXED lag and autolag=None,
    because src/timeseries/adf.ts regresses on a constant + lagged level + lagged diffs.
"""

import json
import math
import os

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy.stats import f as f_dist
from statsmodels.stats.diagnostic import acorr_ljungbox
from statsmodels.tsa.stattools import acf, adfuller, pacf

HERE = os.path.dirname(os.path.abspath(__file__))


def num(value):
    """JSON-safe float (None for NaN, sentinel strings for +/- inf)."""
    value = float(value)
    if math.isnan(value):
        return None
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def vec(values):
    return [num(v) for v in values]


def write(name, payload):
    path = os.path.join(HERE, name)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    print(f"wrote {name}")


# ---------------------------------------------------------------------------
# OLS
# ---------------------------------------------------------------------------

def ols_reference(X, y):
    """Fit statsmodels OLS with an explicit constant; return a dict of metrics."""
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    model = sm.OLS(y, sm.add_constant(X, has_constant="add"))
    res = model.fit()
    return {
        "params": vec(res.params),          # [intercept, b1, b2, ...]
        "fitted": vec(res.fittedvalues),
        "residuals": vec(res.resid),
        "rss": num(res.ssr),                 # residual sum of squares
        "tss": num(res.centered_tss),        # total sum of squares (centered)
        "ess": num(res.ess),                 # explained sum of squares
        "rSquared": num(res.rsquared),
        "adjustedRSquared": num(res.rsquared_adj),
        "stdErrors": vec(res.bse),
        "tStats": vec(res.tvalues),
        "pValues": vec(res.pvalues),
        "fStat": num(res.fvalue),
        "fPValue": num(res.f_pvalue),
        "df": int(res.df_resid),
    }


def make_ols_simple():
    # y ~ 2*x with mild, fixed measurement noise. Small and inspectable by hand.
    x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    y = [2.1, 3.9, 6.2, 7.8, 10.1, 12.2, 13.8, 16.1, 18.0, 19.9]
    write("ols_simple_statsmodels.json", {
        "description": "OLS simple (y = b0 + b1*x) generated with statsmodels.OLS",
        "source": "Python statsmodels 0.14 / numpy",
        "tolerance_notes": "coeffs/fitted/resid/R2 ~1e-9; t/F ~1e-6; p-values ~1e-6",
        "data": {"x": x, "y": y},
        "expected": ols_reference([[v] for v in x], y),
    })


def make_ols_multiple():
    # y = 1.5 + 2*x1 - 0.7*x2 + e, with MODERATE correlation between x1 and x2
    # (x2 tracks x1 loosely) but a well-conditioned, non-singular design.
    x1 = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]
    x2 = [2.0, 1.0, 4.0, 3.0, 6.0, 5.0, 8.0, 7.0, 10.0, 9.0, 12.0, 11.0]
    e = [0.12, -0.20, 0.05, 0.18, -0.10, 0.07, -0.15, 0.09, 0.02, -0.08, 0.11, -0.06]
    y = [1.5 + 2.0 * a - 0.7 * b + n for a, b, n in zip(x1, x2, e)]
    X = [[a, b] for a, b in zip(x1, x2)]
    write("ols_multiple_statsmodels.json", {
        "description": "OLS multiple (y = b0 + b1*x1 + b2*x2) with moderate X-correlation, statsmodels.OLS",
        "source": "Python statsmodels 0.14 / numpy",
        "tolerance_notes": "coeffs/fitted/resid/R2 ~1e-9; t/F ~1e-6; p-values ~1e-6",
        "data": {"X": X, "y": y, "correlation_x1_x2": num(np.corrcoef(x1, x2)[0, 1])},
        "expected": ols_reference(X, y),
    })


def make_ols_three():
    # Three regressors, fixed values, well conditioned.
    x1 = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0]
    x2 = [0.5, 1.5, 1.0, 2.5, 2.0, 3.5, 3.0, 4.5, 4.0, 5.5, 5.0, 6.5, 6.0, 7.5]
    x3 = [3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0, 5.0, 3.0, 5.0, 8.0, 9.0, 7.0]
    e = [0.10, -0.12, 0.04, 0.07, -0.09, 0.06, -0.03, 0.08, -0.05, 0.02, 0.11, -0.07, 0.03, -0.04]
    y = [0.8 + 1.2 * a - 0.5 * b + 0.3 * c + n for a, b, c, n in zip(x1, x2, x3, e)]
    X = [[a, b, c] for a, b, c in zip(x1, x2, x3)]
    write("ols_three_statsmodels.json", {
        "description": "OLS with three regressors (y = b0 + b1*x1 + b2*x2 + b3*x3), statsmodels.OLS",
        "source": "Python statsmodels 0.14 / numpy",
        "tolerance_notes": "coeffs/fitted/resid/R2 ~1e-9; t/F ~1e-6; p-values ~1e-6",
        "data": {"X": X, "y": y},
        "expected": ols_reference(X, y),
    })


# ---------------------------------------------------------------------------
# RLS  (restricted least squares)
# ---------------------------------------------------------------------------

def rls_reference(X, y, R, q):
    X = np.asarray(X, dtype=float)
    y = np.asarray(y, dtype=float)
    R = np.asarray(R, dtype=float)
    q = np.asarray(q, dtype=float)
    n = y.shape[0]
    k = X.shape[1]
    Xd = np.column_stack([np.ones(n), X])
    XtXinv = np.linalg.inv(Xd.T @ Xd)
    beta_ols = XtXinv @ Xd.T @ y
    resid_ols = y - Xd @ beta_ols
    rss_ols = float(resid_ols @ resid_ols)
    middle_inv = np.linalg.inv(R @ XtXinv @ R.T)
    beta_rls = beta_ols - XtXinv @ R.T @ middle_inv @ (R @ beta_ols - q)
    fitted = Xd @ beta_rls
    resid = y - fitted
    rss_rls = float(resid @ resid)
    y_mean = float(np.mean(y))
    tss = float((y - y_mean) @ (y - y_mean))
    df = n - k - 1
    j = R.shape[0]
    r_squared = 0.0 if tss == 0 else 1.0 - rss_rls / tss
    adj = 1.0 - (1.0 - r_squared) * (n - 1.0) / df
    f_stat = ((rss_rls - rss_ols) / j) / (rss_ols / df) if df > 0 and rss_ols > 1e-15 else 0.0
    f_p = float(f_dist.sf(max(0.0, f_stat), j, df)) if df > 0 else 1.0
    return {
        "params": vec(beta_rls),
        "fitted": vec(fitted),
        "residuals": vec(resid),
        "rssOLS": num(rss_ols),
        "rssRLS": num(rss_rls),
        "rSquared": num(r_squared),
        "adjustedRSquared": num(adj),
        "fStatConstraint": num(f_stat),
        "fPValueConstraint": num(f_p),
        "jConstraints": int(j),
        "df": int(df),
    }


def make_rls():
    # Reuse the multiple-regression dataset shape but with three regressors so the
    # restriction templates (beta1=0, beta1+beta2=1, beta2=beta3) are meaningful.
    x1 = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0, 13.0, 14.0]
    x2 = [0.5, 1.5, 1.0, 2.5, 2.0, 3.5, 3.0, 4.5, 4.0, 5.5, 5.0, 6.5, 6.0, 7.5]
    x3 = [3.0, 1.0, 4.0, 1.0, 5.0, 9.0, 2.0, 6.0, 5.0, 3.0, 5.0, 8.0, 9.0, 7.0]
    e = [0.10, -0.12, 0.04, 0.07, -0.09, 0.06, -0.03, 0.08, -0.05, 0.02, 0.11, -0.07, 0.03, -0.04]
    y = [0.8 + 1.2 * a - 0.5 * b + 0.3 * c + n for a, b, c, n in zip(x1, x2, x3, e)]
    X = [[a, b, c] for a, b, c in zip(x1, x2, x3)]

    cases = [
        {"label": "beta1 = 0", "R": [[0, 1, 0, 0]], "q": [0]},
        {"label": "beta1 + beta2 = 1", "R": [[0, 1, 1, 0]], "q": [1]},
        {"label": "beta2 = beta3", "R": [[0, 0, 1, -1]], "q": [0]},
        {
            "label": "beta1 - beta2 = 0.25; beta2 + beta3 = 1",
            "R": [[0, 1, -1, 0], [0, 0, 1, 1]],
            "q": [0.25, 1],
        },
    ]
    out = []
    for case in cases:
        out.append({
            "label": case["label"],
            "constraint": {"R": case["R"], "q": case["q"]},
            "expected": rls_reference(X, y, case["R"], case["q"]),
        })
    write("rls_restrictions_statsmodels.json", {
        "description": "RLS closed-form b_R = b_OLS - (X'X)^-1 R'[R(X'X)^-1 R']^-1 (R b_OLS - q) + scipy F test",
        "source": "Python numpy matrix algebra / scipy.stats.f",
        "tolerance_notes": "params/rss/R2 ~1e-9; F/p ~1e-8",
        "data": {"X": X, "y": y},
        "cases": out,
    })


# ---------------------------------------------------------------------------
# Time series
# ---------------------------------------------------------------------------

def series_reference(values, max_lag, ljung_lags, adf_lag):
    s = np.asarray(values, dtype=float)
    n = len(s)
    acf_full = acf(s, nlags=max_lag, adjusted=False, fft=False)
    pacf_full = pacf(s, nlags=max_lag, method="ldb")
    lb = acorr_ljungbox(s, lags=list(ljung_lags), boxpierce=False, return_df=True)
    adf_stat = None
    if adf_lag is not None:
        adf_res = adfuller(s, maxlag=adf_lag, regression="c", autolag=None)
        adf_stat = num(adf_res[0])
    return {
        "observations": n,
        "maxLag": max_lag,
        # lags 1..max_lag (drop lag 0 == 1) to match ChartBay's rows/pacf arrays
        "acf": vec(acf_full[1:]),
        "pacf": vec(pacf_full[1:]),
        "ljungBox": [
            {"lag": int(lag), "qStatistic": num(q), "pValue": num(p)}
            for lag, q, p in zip(ljung_lags, lb["lb_stat"], lb["lb_pvalue"])
        ],
        "adfLag": adf_lag,
        "adfStatistic": adf_stat,
    }


def make_time_series():
    rng = np.random.default_rng(20240607)

    # 1) Simple increasing series
    increasing = [float(v) for v in range(1, 11)]

    # 2) White noise (store the realised draw so it is reproducible without numpy)
    white = rng.standard_normal(60)
    white_list = [float(v) for v in white]

    # 3) AR(1) stationary: y_t = 0.6 y_{t-1} + e_t
    shocks_ar = rng.standard_normal(60)
    ar = np.zeros(60)
    for t in range(1, 60):
        ar[t] = 0.6 * ar[t - 1] + shocks_ar[t]
    ar_list = [float(v) for v in ar]

    # 4) Random walk: y_t = y_{t-1} + e_t
    shocks_rw = rng.standard_normal(60)
    rw = np.cumsum(shocks_rw)
    rw_list = [float(v) for v in rw]

    # 5) Price-index level: the pathological ADF design. Levels run 100..450
    #    while their differences run 1..10, and the Schwert lag (11) adds eleven
    #    lagged differences that are nearly collinear with each other. Solving
    #    this through the normal equations returned 0.08 where the statistic is
    #    4.37, which is why src/qrLeastSquares.ts exists. The other series here
    #    all sit on a unit-ish scale with adf_lag=1, so they never caught it.
    index_level = [
        float(round(100 * float(np.exp(0.021 * i + 0.01 * np.sin(i))), 4)) for i in range(72)
    ]

    payload = {
        "description": "ACF (biased), PACF (Levinson-Durbin biased, method=ldb), Ljung-Box and ADF references",
        "source": "Python statsmodels.tsa.stattools / statsmodels.stats.diagnostic",
        "tolerance_notes": "acf/pacf ~1e-9; ljung-box Q/p ~1e-7; adf statistic ~1e-6",
        "series": {
            "increasing": {
                "data": increasing,
                "expected": series_reference(increasing, max_lag=4, ljung_lags=[5], adf_lag=None),
            },
            "white_noise": {
                "data": white_list,
                "expected": series_reference(white_list, max_lag=10, ljung_lags=[5, 10, 20], adf_lag=1),
            },
            "ar1_phi_0_6": {
                "data": ar_list,
                "expected": series_reference(ar_list, max_lag=10, ljung_lags=[5, 10, 20], adf_lag=1),
            },
            "random_walk": {
                "data": rw_list,
                "expected": series_reference(rw_list, max_lag=10, ljung_lags=[5, 10, 20], adf_lag=1),
            },
            "price_index_level": {
                "data": index_level,
                "expected": series_reference(index_level, max_lag=10, ljung_lags=[5, 10, 20], adf_lag=11),
            },
        },
    }
    write("time_series_statsmodels.json", payload)


# ---------------------------------------------------------------------------
# Transforms (diff / pct_change / log returns / moving average)
# ---------------------------------------------------------------------------

def make_transforms():
    levels = [100.0, 102.0, 99.0, 105.0, 108.0, 104.0, 110.0]
    s = pd.Series(levels)

    diff = s.diff().tolist()                       # first -> NaN
    pct = (s.pct_change() * 100.0).tolist()        # first -> NaN, percent
    logret = np.log(s / s.shift(1)).tolist()       # first -> NaN
    sma3 = s.rolling(window=3).mean().tolist()     # first two -> NaN

    def clean_list(arr):
        return [None if (v is None or (isinstance(v, float) and math.isnan(v))) else num(v) for v in arr]

    write("transforms_pandas.json", {
        "description": "Series transforms validated against pandas / numpy",
        "source": "pandas Series.diff / pct_change / rolling, numpy.log",
        "tolerance_notes": "~1e-9; nulls where the transform is undefined at the first/early index",
        "data": {"levels": levels},
        "expected": {
            "simpleDifference": clean_list(diff),
            "percentReturn": clean_list(pct),
            "logReturn": clean_list(logret),
            "simpleMovingAverage_window3": clean_list(sma3),
        },
    })


# ---------------------------------------------------------------------------
# Functional forms
# ---------------------------------------------------------------------------

def make_functional_forms():
    """Fixtures for lin-lin, log-lin, lin-log, log-log.

    All datasets use small, fixed, POSITIVE values so every form is valid.
    statsmodels always receives the already-transformed arrays; it adds the
    constant via sm.add_constant (ChartBay does the same internally in runOLS).
    """

    # Small dataset: all values strictly positive — required for log transforms.
    x_raw = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    y_raw = [2.1, 4.2, 5.9, 8.3, 10.4, 12.1, 14.2, 16.0, 17.8, 20.1]

    # Two-regressor dataset — also all positive.
    x1_raw = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 11.0, 12.0]
    x2_raw = [2.0, 3.0, 2.5, 4.0, 3.5, 5.0, 4.5, 6.0, 5.5, 7.0, 6.5, 8.0]
    y2_raw = [1.5, 2.8, 3.1, 4.5, 5.2, 6.8, 7.3, 8.9, 9.4, 11.0, 11.5, 13.1]

    cases = []

    # ── lin-lin ──────────────────────────────────────────────────────────────
    ref = ols_reference([[x] for x in x_raw], y_raw)
    cases.append({
        "form": "lin-lin",
        "description": "lin-lin: Y = b0 + b1*X (no transform), statsmodels.OLS",
        "data": {"x": x_raw, "y": y_raw},
        "transformNote": "No transformation applied. Y and X passed as-is.",
        "expected": ref,
        "interpretation": {
            "kind": "absolute",
            "approxRule": "A 1-unit increase in X changes Y by beta units."
        }
    })

    # ── log-lin ──────────────────────────────────────────────────────────────
    ln_y = [math.log(v) for v in y_raw]
    ref = ols_reference([[x] for x in x_raw], ln_y)
    cases.append({
        "form": "log-lin",
        "description": "log-lin: ln(Y) = b0 + b1*X, statsmodels.OLS on transformed data",
        "data": {"x": x_raw, "y": y_raw},
        "transformNote": "Y is log-transformed. X is passed as-is.",
        "expected": ref,
        "interpretation": {
            "kind": "semielasticity",
            "approxRule": "A 1-unit increase in X changes Y by approximately 100*beta %.",
            "exactRule": "Exact: 100*(exp(beta)-1) %."
        }
    })

    # ── lin-log ──────────────────────────────────────────────────────────────
    ln_x = [math.log(v) for v in x_raw]
    ref = ols_reference([[lx] for lx in ln_x], y_raw)
    cases.append({
        "form": "lin-log",
        "description": "lin-log: Y = b0 + b1*ln(X), statsmodels.OLS on transformed data",
        "data": {"x": x_raw, "y": y_raw},
        "transformNote": "X is log-transformed. Y is passed as-is.",
        "expected": ref,
        "interpretation": {
            "kind": "semielasticity-x",
            "approxRule": "A 1% increase in X changes Y by approximately beta/100 units."
        }
    })

    # ── log-log ───────────────────────────────────────────────────────────────
    ref = ols_reference([[lx] for lx in ln_x], ln_y)
    cases.append({
        "form": "log-log",
        "description": "log-log: ln(Y) = b0 + b1*ln(X) (elasticity), statsmodels.OLS",
        "data": {"x": x_raw, "y": y_raw},
        "transformNote": "Both Y and X are log-transformed.",
        "expected": ref,
        "interpretation": {
            "kind": "elasticity",
            "approxRule": "A 1% increase in X changes Y by approximately beta %."
        }
    })

    # ── log-log with two regressors ───────────────────────────────────────────
    ln_x1 = [math.log(v) for v in x1_raw]
    ln_x2 = [math.log(v) for v in x2_raw]
    ln_y2 = [math.log(v) for v in y2_raw]
    ref2 = ols_reference([[a, b] for a, b in zip(ln_x1, ln_x2)], ln_y2)
    cases.append({
        "form": "log-log",
        "description": "log-log two regressors: ln(Y) = b0 + b1*ln(X1) + b2*ln(X2)",
        "data": {"x1": x1_raw, "x2": x2_raw, "y": y2_raw},
        "transformNote": "Y, X1 and X2 all log-transformed.",
        "expected": ref2,
        "interpretation": {
            "kind": "elasticity",
            "approxRule": "Each beta is an elasticity with respect to its regressor."
        }
    })

    write("functional_forms_statsmodels.json", {
        "description": "Functional forms (lin-lin, log-lin, lin-log, log-log) reference via statsmodels.OLS",
        "source": "Python statsmodels / numpy — np.log, sm.add_constant, OLS.fit()",
        "tolerance_notes": "coeffs/fitted/resid/R2 ~1e-9; std errors ~1e-7; t/F/p ~1e-6",
        "cases": cases,
    })


if __name__ == "__main__":
    make_ols_simple()
    make_ols_multiple()
    make_ols_three()
    make_rls()
    make_time_series()
    make_transforms()
    make_functional_forms()
    print("All fixtures generated.")
