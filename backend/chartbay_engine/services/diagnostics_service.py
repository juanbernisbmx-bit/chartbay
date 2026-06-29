"""Lógica de negocio de diagnósticos de series de tiempo (ADF; ACF/PACF en Etapa E)."""

from __future__ import annotations

from collections.abc import Sequence

from chartbay_engine.core.econometrics.time_series.stationarity import ADFResult, run_adf


def adf(*, values: Sequence[float], lag: int | None = None) -> ADFResult:
    return run_adf(values, lag=lag)
