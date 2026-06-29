"""Autocorrelación: ACF, PACF (Durbin-Levinson) y test de Ljung-Box.

Porta `quantbay/src/timeseries/acf.ts`:
- ACF con el estimador sesgado estándar  ρ_k = Σ_{t>k} c_t c_{t-k} / Σ c_t²
- PACF por la recursión de Durbin-Levinson sobre la ACF sesgada
- Ljung-Box  Q = n(n+2) Σ_{k=1}^{m} ρ_k²/(n−k)  en los lags 5, 10 y 20

Validado contra `statsmodels` (`acf` adjusted=False, `pacf` method="ldbiased",
`acorr_ljungbox`) en `tests/test_autocorrelation.py` (ADR-1).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from chartbay_engine.core.econometrics import inference
from chartbay_engine.core.errors import InvalidInputError

MIN_OBSERVATIONS = 4
DEFAULT_MAX_LAG = 12
HARD_MAX_LAG = 40
LJUNG_BOX_LAGS = (5, 10, 20)
_EPS = 1e-12


@dataclass(frozen=True)
class ACFLag:
    lag: int
    autocorrelation: float
    threshold: float
    outside_threshold: bool


@dataclass(frozen=True)
class PACFLag:
    lag: int
    partial_autocorrelation: float
    threshold: float
    outside_threshold: bool


@dataclass(frozen=True)
class LjungBoxLag:
    lag: int
    q_statistic: float
    p_value: float
    interpretation: str


@dataclass(frozen=True)
class AutocorrelationResult:
    observations: int
    requested_max_lag: int
    max_lag: int
    threshold: float | None
    rows: list[ACFLag]
    pacf: list[PACFLag]
    ljung_box: list[LjungBoxLag]
    warnings: list[str]
    interpretation: str
    pacf_interpretation: str


def _acf_interpretation(rows: list[ACFLag]) -> str:
    if not rows:
        return "ACF is unavailable for this transformed series."
    strongest = max(rows, key=lambda r: abs(r.autocorrelation))
    if strongest.autocorrelation > 0.1:
        return "Positive autocorrelation suggests persistence at that lag."
    if strongest.autocorrelation < -0.1:
        return "Negative autocorrelation suggests reversal or oscillation at that lag."
    return "Near-zero autocorrelation suggests weak linear dependence at that lag."


def _pacf_interpretation(rows: list[PACFLag]) -> str:
    if not rows:
        return "PACF is unavailable for this transformed series."
    if any(row.lag <= 3 and row.outside_threshold for row in rows):
        return (
            "Significant early PACF lags may suggest autoregressive structure. PACF cutoff "
            "patterns can help identify a possible AR order, but treat this as an educational "
            "diagnostic rather than a standalone model decision."
        )
    return (
        "PACF cutoff patterns can help identify a possible AR order. No early lag clearly "
        "exceeds the approximate threshold in this view, so avoid overclaiming from PACF alone."
    )


def _ljung_box_interpretation(p_value: float) -> str:
    return (
        "p < 0.05: evidence of autocorrelation remaining."
        if p_value < 0.05
        else "p >= 0.05: no strong evidence of autocorrelation."
    )


def _durbin_levinson(rho: list[float], max_lag: int, threshold: float) -> list[PACFLag]:
    """PACF por la recursión de Durbin-Levinson. ``rho`` = [1, ρ_1, …, ρ_maxLag]."""
    rows: list[PACFLag] = []
    previous_phi: list[float] = []
    prediction_variance = 1.0

    for lag in range(1, max_lag + 1):
        if prediction_variance <= _EPS or not np.isfinite(prediction_variance):
            break
        numerator = rho[lag]
        for j in range(1, lag):
            numerator -= previous_phi[j - 1] * rho[lag - j]
        phi = 0.0 if abs(numerator) <= _EPS else numerator / prediction_variance
        if not np.isfinite(phi):
            break
        rows.append(PACFLag(lag, phi, threshold, abs(phi) > threshold))
        next_phi = [
            value - phi * previous_phi[lag - index - 2]
            for index, value in enumerate(previous_phi)
        ]
        next_phi.append(phi)
        previous_phi = next_phi
        prediction_variance *= max(0.0, 1.0 - phi**2)

    return rows


def _compute_ljung_box(autocorrelations: list[ACFLag], n: int) -> list[LjungBoxLag]:
    result: list[LjungBoxLag] = []
    for lag in LJUNG_BOX_LAGS:
        if not (0 < lag < n):
            continue
        partial = sum(
            row.autocorrelation**2 / (n - row.lag) for row in autocorrelations[:lag]
        )
        q = partial * n * (n + 2)
        p_value = inference.chi2_sf(q, lag)
        result.append(LjungBoxLag(lag, q, p_value, _ljung_box_interpretation(p_value)))
    return result


def _empty(
    n: int, requested_max_lag: int, max_lag: int, warnings: list[str]
) -> AutocorrelationResult:
    return AutocorrelationResult(
        observations=n,
        requested_max_lag=requested_max_lag,
        max_lag=max_lag,
        threshold=None,
        rows=[],
        pacf=[],
        ljung_box=[],
        warnings=warnings,
        interpretation=_acf_interpretation([]),
        pacf_interpretation=_pacf_interpretation([]),
    )


def run_autocorrelation(values, requested_max_lag: int | None = None) -> AutocorrelationResult:
    """Calcula ACF, PACF y Ljung-Box. ``requested_max_lag`` opcional (12 por defecto)."""
    try:
        arr = np.asarray(values, dtype=float)
    except (TypeError, ValueError) as exc:
        raise InvalidInputError(
            "La serie de autocorrelación debe contener sólo valores numéricos."
        ) from exc
    if arr.ndim != 1:
        raise InvalidInputError("La serie de autocorrelación debe ser un vector 1D.")
    if not np.all(np.isfinite(arr)):
        raise InvalidInputError(
            "La serie de autocorrelación debe contener sólo valores finitos."
        )

    clean = [float(v) for v in arr]
    n = len(clean)
    warnings: list[str] = []
    raw_max_lag = DEFAULT_MAX_LAG if requested_max_lag is None else requested_max_lag

    if n < MIN_OBSERVATIONS:
        warnings.append("ACF needs at least 4 observations in the selected transformed series.")
        return _empty(n, raw_max_lag, 0, warnings)

    safe_max_lag = min(HARD_MAX_LAG, max(1, (n - 1) // 2))
    max_lag = min(max(raw_max_lag, 1), safe_max_lag)
    if raw_max_lag != max_lag:
        warnings.append(f"ACF max lag must be between 1 and {safe_max_lag}; using {max_lag}.")
    if raw_max_lag > safe_max_lag or max_lag >= n / 2:
        warnings.append(
            "ACF max lag should be meaningfully smaller than the transformed sample size."
        )

    mean = float(arr.mean())
    centered = arr - mean
    denom = float(centered @ centered)
    if denom <= _EPS:
        warnings.append("ACF is undefined for a constant transformed series.")
        return _empty(n, raw_max_lag, max_lag, warnings)

    threshold = 1.96 / np.sqrt(n)
    lb_lags = [lag for lag in LJUNG_BOX_LAGS if lag < n]
    ljung_box_max_lag = max([max_lag, *lb_lags])

    autocorrelations: list[ACFLag] = []
    for lag in range(1, ljung_box_max_lag + 1):
        numerator = float(centered[lag:] @ centered[:-lag])
        ac = 0.0 if abs(numerator) <= _EPS else numerator / denom
        autocorrelations.append(ACFLag(lag, ac, threshold, abs(ac) > threshold))

    rows = autocorrelations[:max_lag]
    rho = [1.0, *[row.autocorrelation for row in autocorrelations[:max_lag]]]
    pacf = _durbin_levinson(rho, max_lag, threshold)
    ljung_box = _compute_ljung_box(autocorrelations, n)

    return AutocorrelationResult(
        observations=n,
        requested_max_lag=raw_max_lag,
        max_lag=max_lag,
        threshold=float(threshold),
        rows=rows,
        pacf=pacf,
        ljung_box=ljung_box,
        warnings=warnings,
        interpretation=_acf_interpretation(rows),
        pacf_interpretation=_pacf_interpretation(pacf),
    )
