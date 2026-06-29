"""Contratos de la API de diagnósticos de series de tiempo (ADF; ACF/PACF en Etapa E)."""

from __future__ import annotations

from pydantic import Field

from chartbay_engine.schemas.common import CamelModel


class ADFRequest(CamelModel):
    values: list[float] = Field(description="Serie de valores (numéricos, finitos).")
    lag: int | None = Field(
        default=None,
        description="Lag a usar. Si se omite, se elige automáticamente (regla de Schwert).",
    )


class ADFCriticalValuesSchema(CamelModel):
    one_percent: float
    five_percent: float
    ten_percent: float


class ADFResultSchema(CamelModel):
    """Resultado del test ADF. Serializa en camelCase; campos None se omiten."""

    available: bool
    n_obs: int
    statistic: float | None = None
    p_value: float | None = None
    used_lag: int | None = None
    critical_values: ADFCriticalValuesSchema | None = None
    is_stationary: bool | None = None
    reason: str | None = None
