"""Test de Dickey-Fuller Aumentado (ADF) para estacionariedad.

La regresión ADF (con constante, regression='c') se estima con nuestro propio OLS
(`run_ols`), de modo que el estadístico es t(ρ̂) sobre el nivel rezagado y_{t-1} en

    Δy_t = α + ρ·y_{t-1} + Σ_{i=1}^{p} γ_i·Δy_{t-i} + ε_t

Mejora sobre el motor TS (que devuelve ``pValue: null``): el **p-valor y los valores
críticos de MacKinnon** se obtienen de ``statsmodels.tsa.adfvalues`` (ADR-4). El
estadístico se valida contra ``statsmodels.tsa.stattools.adfuller`` (mismo lag) en
`tests/test_stationarity.py`.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from statsmodels.tsa.adfvalues import mackinnoncrit, mackinnonp

from chartbay_engine.core.econometrics.regression.ols import run_ols
from chartbay_engine.core.errors import EngineError, InvalidInputError

MIN_OBSERVATIONS = 8
_VARIANCE_EPS = 1e-12
_STATIONARITY_ALPHA = 0.05


@dataclass(frozen=True)
class ADFCriticalValues:
    one_percent: float
    five_percent: float
    ten_percent: float


@dataclass(frozen=True)
class ADFResult:
    available: bool
    n_obs: int
    statistic: float | None = None
    p_value: float | None = None
    used_lag: int | None = None
    critical_values: ADFCriticalValues | None = None
    is_stationary: bool | None = None
    reason: str | None = None


def _automatic_lag(n: int) -> int:
    """Regla de Schwert (igual que el motor TS), acotada a un lag factible."""
    schwert = int(np.floor(12 * (n / 100) ** 0.25))
    max_allowed = max(0, (n - 4) // 2)
    return min(schwert, max_allowed)


def _unavailable(n_obs: int, reason: str, used_lag: int | None = None) -> ADFResult:
    return ADFResult(available=False, n_obs=n_obs, used_lag=used_lag, reason=reason)


def run_adf(values, lag: int | None = None) -> ADFResult:
    """Ejecuta el test ADF. ``lag`` opcional; si se omite, se usa la regla de Schwert."""
    if lag is not None and lag < 0:
        raise InvalidInputError(
            "El lag del ADF debe ser un entero no negativo.",
            details={"lag": lag},
        )

    try:
        arr = np.asarray(values, dtype=float)
    except (TypeError, ValueError) as exc:
        raise InvalidInputError("La serie ADF debe contener sólo valores numéricos.") from exc
    if arr.ndim != 1:
        raise InvalidInputError("La serie ADF debe ser un vector 1D.")
    if not np.all(np.isfinite(arr)):
        raise InvalidInputError("La serie ADF debe contener sólo valores finitos.")

    clean = [float(v) for v in arr]
    n = len(clean)

    if n < MIN_OBSERVATIONS:
        return _unavailable(
            n, f"El ADF necesita al menos {MIN_OBSERVATIONS} observaciones finitas."
        )

    if float(arr.var(ddof=1)) <= _VARIANCE_EPS:
        return _unavailable(n, "El ADF no está definido para una serie constante.")

    used_lag = _automatic_lag(n) if lag is None else lag

    # Factibilidad: filas = n - used_lag - 1; regresores = 1 + used_lag; se necesita
    # filas >= regresores + 2  ⇔  n >= 2·used_lag + 4.
    if n < 2 * used_lag + 4:
        return _unavailable(
            n,
            f"La serie es muy chica para lag {used_lag}: se necesitan al menos "
            f"{2 * used_lag + 4} observaciones finitas.",
            used_lag=used_lag,
        )

    diffs = [clean[i + 1] - clean[i] for i in range(n - 1)]
    y: list[float] = []
    design: list[list[float]] = []
    for t in range(used_lag + 1, n):
        y.append(diffs[t - 1])
        design.append([clean[t - 1], *[diffs[t - index - 2] for index in range(used_lag)]])

    names = ["lagged_level", *[f"diff_lag_{i + 1}" for i in range(used_lag)]]
    try:
        ols = run_ols(design, y, names, "delta")
    except EngineError as exc:
        return _unavailable(n, f"La regresión ADF no pudo estimarse: {exc.message}", used_lag)

    statistic = ols.t_stats[1]  # t sobre el nivel rezagado y_{t-1}
    if not np.isfinite(statistic):
        return _unavailable(n, "La regresión ADF produjo un estadístico no finito.", used_lag)

    reg_nobs = ols.n_obs
    p_value = float(mackinnonp(statistic, regression="c", N=1))
    crit = mackinnoncrit(N=1, regression="c", nobs=reg_nobs)
    critical_values = ADFCriticalValues(
        one_percent=float(crit[0]),
        five_percent=float(crit[1]),
        ten_percent=float(crit[2]),
    )

    return ADFResult(
        available=True,
        n_obs=n,
        statistic=float(statistic),
        p_value=p_value,
        used_lag=used_lag,
        critical_values=critical_values,
        is_stationary=bool(p_value < _STATIONARITY_ALPHA),
    )
