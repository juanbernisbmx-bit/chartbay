# ChartBay TypeScript Math Validation

## Summary

This document records the mathematical validation of the **TypeScript** quant engine
in `quantbay/`. The engine's OLS, RLS, time-series, and series-transform functions
were validated against trusted Python references (statsmodels, NumPy, SciPy, pandas).

All validated functions match their Python references within the tolerances listed
below. No mathematical bugs were found during this validation pass. This is a
validation record, not a guarantee of correctness for every possible dataset.

## Scope

- **Only the TypeScript engine is validated.** Python is used solely to produce
  reference values.
- Two complementary mechanisms are used:
  1. **Committed JSON fixtures** (`quantbay/tests/fixtures/*.json`), generated once
     by `quantbay/tests/fixtures/generate_fixtures.py`. The TypeScript tests read
     these fixtures, so the suite is **reproducible on a machine without Python /
     statsmodels installed**.
  2. **Live statsmodels sweep** (`quantbay/tests/statsmodelsValidation.test.ts`),
     which spawns Python at test time to validate OLS/RLS over many randomized
     datasets. This requires Python + statsmodels to be installed.

## Reference libraries

| Library | Version | Used for |
|---|---|---|
| statsmodels | 0.14.x | OLS inference, ACF, PACF, Ljung-Box, ADF |
| numpy | 2.x | matrix algebra, RLS closed form, log returns |
| scipy | 1.x | F-distribution survival function (RLS F test) |
| pandas | 3.x | diff, pct_change, rolling mean |

## Validated functions

| Area | TypeScript source | Reference |
|---|---|---|
| OLS | `src/regression.ts` (`runOLS`) | `statsmodels.OLS` |
| RLS | `src/rls.ts` (`runRLS`) | closed-form + `scipy.stats.f` |
| ACF | `src/timeseries/acf.ts` (`computeAutocorrelation`) | `statsmodels.tsa.stattools.acf` |
| PACF | `src/timeseries/acf.ts` | `statsmodels.tsa.stattools.pacf` |
| Ljung-Box | `src/timeseries/acf.ts` | `statsmodels.stats.diagnostic.acorr_ljungbox` |
| ADF | `src/timeseries/adf.ts` (`computeADF`) | `statsmodels.tsa.stattools.adfuller` |
| Transforms | `src/timeseries/transforms.ts` | `pandas` / `numpy` |
| Data validation | `src/services/analysisService.ts`, `src/timeseries/validation.ts` | behavioural (no numeric reference) |

## OLS validation

`runOLS` was checked against `statsmodels.OLS` for simple (1 regressor), multiple
(2 regressors, moderately correlated), and three-regressor models. Validated
quantities: coefficients/intercept, fitted values, residuals, RSS, TSS, ESS,
R², adjusted R², standard errors, t-statistics, p-values, F-statistic and its
p-value.

**Intercept handling.** The ChartBay TypeScript engine **always includes an
intercept**: `runOLS` builds the design matrix as `Xd = [1, ...x]` internally.
There is **no no-intercept (regression-through-the-origin) mode**. This matters
when comparing against statsmodels, which only adds a constant when you call
`sm.add_constant`; all references here use `sm.add_constant(...)`. A zero-variance
(constant) feature column is rejected as rank-deficient because it duplicates the
automatic intercept.

Property tests confirm, on the validated datasets:
- residuals sum to ≈ 0 (intercept model),
- `Xᵀ · residuals ≈ 0` (normal equations),
- `fitted + residual = y` exactly,
- `0 ≤ R² ≤ 1` and `adjusted R² ≤ R²`,
- `RSS ≈ TSS − ESS`.

### Data validation and rank deficiency

Covered by the existing suite plus `statsmodelsValidation.test.ts`:
- non-numeric / missing / `Infinity` cells flagged before estimation,
- constant predictor rejected as rank-deficient against the intercept,
- **perfect multicollinearity** (e.g. `x2 = 2·x1`, duplicated columns) rejected
  with a diagnostic via Gram-Schmidt rank detection — no silent absurd output,
- too few observations / more regressors than observations rejected,
- near-singular but full-rank designs produce finite output.

## RLS validation

`runRLS` was checked against the closed-form restricted estimator

```
b_R = b_OLS − (X'X)⁻¹ R' [R (X'X)⁻¹ R']⁻¹ (R b_OLS − q)
```

with the restriction F-test referenced against `scipy.stats.f`. Restriction
templates validated: `β1 = 0`, `β1 + β2 = 1`, `β2 = β3`, and a simultaneous
two-restriction case. Validated quantities: restricted coefficients, fitted
values, residuals, RSS_OLS, RSS_RLS, R², adjusted R², restriction F-statistic and
p-value.

Mandatory properties asserted on every case:
- `RSS_RLS ≥ RSS_OLS`,
- `R · β_RLS = q` (restriction holds exactly),
- `F_constraint ≥ 0`.

Invalid restrictions (empty, wrong column count, more restrictions than
parameters, redundant/collinear restriction rows) are rejected with clear errors.

## Time series validation

- **ACF** uses the **biased** estimator (denominator = full sum of squared
  deviations), matching `statsmodels.acf(adjusted=False)`. Reported rows start at
  lag 1 (lag 0 ≡ 1 is dropped).
- **PACF** uses the Levinson-Durbin recursion on the biased ACF, matching
  `statsmodels.pacf(method='ldb')`.
- **Ljung-Box** Q and p-values match `acorr_ljungbox` at lags 5/10/20.
- **ADF** statistic matches `adfuller(regression='c', autolag=None)` for a fixed
  lag. ChartBay reports the regression t-statistic and compares it to **hardcoded
  critical values** (1% −3.43, 5% −2.86, 10% −2.57); it does **not** compute a
  MacKinnon p-value (see Known differences).

Reference series: a deterministic increasing ramp, a seeded white-noise draw, a
stationary AR(1) (φ = 0.6), and a random walk. The realised random draws are
stored verbatim in the fixture so results are reproducible without re-running
NumPy.

## Finance validation

**No dedicated finance engine exists in the TypeScript scope.** There are no
Sharpe ratio, drawdown, volatility, covariance, or beta-vs-benchmark functions to
validate. The only return-style functions are in `src/timeseries/transforms.ts`
(`percentReturn`, `logReturn`), which are validated against pandas/numpy. No
finance functions were built for this validation pass.

## Tolerances

| Quantity | Tolerance (relative) |
|---|---|
| OLS/RLS coefficients, fitted, residuals, R² | 1e-9 |
| OLS standard errors | 1e-7 |
| t-statistics, F-statistics | 1e-6 |
| p-values | 1e-6 |
| RLS restriction F / p | 1e-7 |
| ACF | 1e-9 |
| PACF | 1e-8 |
| Ljung-Box Q / p | 1e-7 / 1e-6 |
| ADF statistic | 1e-6 |
| Transforms (diff / returns / SMA) | 1e-9 |

The live randomized OLS/RLS sweep observed a maximum scaled difference of
≈ 2.5e-14 against statsmodels.

## Known differences vs statsmodels

- **ADF p-values:** ChartBay does not implement MacKinnon's interpolated
  p-values; it reports the t-statistic plus fixed critical values only. The
  statistic itself matches statsmodels.
- **ADF lag selection:** ChartBay's automatic lag uses a Schwert rule with a
  decrement-on-failure fallback; statsmodels offers `autolag` (AIC/BIC). For
  validation a fixed lag is supplied to both sides so the regressions coincide.
- **PACF estimator choice:** ChartBay is fixed to the biased Levinson-Durbin
  estimator (`ldb`). statsmodels defaults to a different method, so comparisons
  pin `method='ldb'`.

## Current confidence level

**Economista junior.** The core estimators (OLS, RLS) and the basic time-series
diagnostics (ACF, PACF, Ljung-Box, ADF statistic) reproduce standard tooling to
tight tolerances, and the engine fails safely on degenerate input. This is
appropriate for student and junior-economist use.

It is **not** yet at "técnico avanzado / producción profesional" level because of
the pending items below.

## Pending validation

- ADF MacKinnon p-values (currently not computed).
- Heteroskedasticity / autocorrelation-robust (HAC) standard errors (not
  implemented).
- KPSS and other stationarity tests (not implemented).
- A dedicated finance module (Sharpe, drawdown, volatility, beta) — none exists
  yet.
- Wider numerical stress testing of ill-conditioned designs beyond the current
  near-singular cases.
