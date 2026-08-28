# ChartBay OLS/RLS Validation

This document summarizes the current validation coverage for ChartBay's econometric engine. It is a validation record, not a claim that the app is mathematically perfect for every possible dataset.

## Scope Validated

ChartBay's OLS and Restricted Least Squares (RLS) calculations were compared against independent Python reference implementations using NumPy, SciPy, and statsmodels where applicable.

The validation covers:

- Coefficients
- Fitted values
- Residuals
- RSS
- R-squared and adjusted R-squared
- Restricted F-statistic
- Restricted p-value

## RLS Reference Formula

The independent RLS reference uses the standard restricted least squares estimator:

```text
beta_R = beta_OLS - (X'X)^-1 R' [R (X'X)^-1 R']^-1 (R beta_OLS - q)
```

where `R beta = q` defines the linear restrictions.

## Randomized Validation

The RLS validation suite includes 240 randomized RLS cases compared against the independent Python/NumPy/SciPy reference.

Restrictions covered:

- `beta1 = 0`
- `beta2 = 0`
- `beta1 = beta2`
- `beta1 + beta2 = 1`
- `beta1 - beta2 = 0`
- Multiple simultaneous restrictions

## Edge Cases

The automated validation also covers:

- Perfect restricted fit
- Near-singular `X'X`
- Redundant restrictions
- Invalid restrictions
- Too many restrictions

UI-facing behavior is tested so invalid or unsupported RLS restrictions are rejected clearly rather than silently displaying an unrelated OLS result.

## Current Test Status

Latest validation status:

- `npm test`: 1507 passed in 85 test files
- `npx tsc --noEmit --pretty false`: passed
- `npm run build`: passed

## Remaining Limitation

Near-singular designs remain conditioning-sensitive because the implementation relies on normal-equation inversion. The tests cover this behavior with appropriate tolerances, but users should still treat highly collinear or nearly singular datasets as numerically fragile.
