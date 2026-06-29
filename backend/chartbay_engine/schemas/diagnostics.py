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


class AutocorrelationRequest(CamelModel):
    values: list[float] = Field(description="Serie de valores (numéricos, finitos).")
    max_lag: int | None = Field(
        default=None, description="Lag máximo a calcular. Por defecto 12 (acotado a la muestra)."
    )


class ACFLagSchema(CamelModel):
    lag: int
    autocorrelation: float
    threshold: float
    outside_threshold: bool


class PACFLagSchema(CamelModel):
    lag: int
    partial_autocorrelation: float
    threshold: float
    outside_threshold: bool


class LjungBoxLagSchema(CamelModel):
    lag: int
    q_statistic: float
    p_value: float
    interpretation: str


class AutocorrelationResultSchema(CamelModel):
    observations: int
    requested_max_lag: int
    max_lag: int
    threshold: float | None = None
    rows: list[ACFLagSchema]
    pacf: list[PACFLagSchema]
    ljung_box: list[LjungBoxLagSchema]
    warnings: list[str]
    interpretation: str
    pacf_interpretation: str
