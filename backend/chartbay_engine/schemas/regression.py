"""Contratos de la API de regresión (espejan `RegressionResult` del frontend TS)."""

from __future__ import annotations

from collections.abc import Sequence

from pydantic import Field, model_validator

from chartbay_engine.schemas.common import CamelModel


def _validate_design_shapes(
    x: Sequence[Sequence[float]], y: Sequence[float], feature_names: Sequence[str]
) -> None:
    """Chequeo de forma compartido por OLSRequest y RLSRequest."""
    if not y:
        raise ValueError("y no puede estar vacío.")
    if not x:
        raise ValueError("X no puede estar vacío.")
    n_cols = len(x[0])
    if any(len(row) != n_cols for row in x):
        raise ValueError("Todas las filas de X deben tener la misma cantidad de columnas.")
    if len(x) != len(y):
        raise ValueError(f"X tiene {len(x)} filas pero y tiene {len(y)} valores.")
    if len(feature_names) != n_cols:
        raise ValueError(
            f"featureNames tiene {len(feature_names)} nombres pero X tiene {n_cols} columna(s)."
        )


class OLSRequest(CamelModel):
    x: list[list[float]] = Field(
        alias="X", description="Matriz de diseño: filas = observaciones, columnas = variables."
    )
    y: list[float] = Field(description="Variable dependiente.")
    feature_names: list[str] = Field(description="Nombres de las columnas de X.")
    y_name: str = Field(default="y", description="Nombre de la variable dependiente.")
    drop_redundant: bool = Field(
        default=False,
        description="Si es true, elimina automáticamente columnas redundantes en lugar de fallar.",
    )

    @model_validator(mode="after")
    def _check_shapes(self) -> OLSRequest:
        _validate_design_shapes(self.x, self.y, self.feature_names)
        return self


class LinearConstraintSchema(CamelModel):
    r: list[list[float]] = Field(
        alias="R", description="Matriz de restricciones J×(k+1) (índice 0 = intercepto)."
    )
    q: list[float] = Field(description="Lado derecho de R·β = q.")
    label: str = Field(default="", description="Etiqueta legible de la restricción.")


class RLSRequest(CamelModel):
    x: list[list[float]] = Field(alias="X", description="Matriz de diseño.")
    y: list[float] = Field(description="Variable dependiente.")
    feature_names: list[str] = Field(description="Nombres de las columnas de X.")
    y_name: str = Field(default="y", description="Nombre de la variable dependiente.")
    constraint: LinearConstraintSchema = Field(description="Restricción lineal R·β = q.")

    @model_validator(mode="after")
    def _check_shapes(self) -> RLSRequest:
        _validate_design_shapes(self.x, self.y, self.feature_names)
        return self


class DroppedFeatureSchema(CamelModel):
    name: str
    reason: str


class RegressionResult(CamelModel):
    """Resultado de una regresión (OLS o RLS). Serializa en camelCase.

    Los campos específicos de RLS quedan en ``None`` para OLS y se omiten en la respuesta
    (``response_model_exclude_none=True`` en el endpoint).
    """

    coefficients: list[float]
    intercept: float
    r_squared: float
    adjusted_r_squared: float
    predictions: list[float]
    residuals: list[float]
    rss: float
    equation: str
    feature_names: list[str]
    y_name: str
    n_obs: int
    n_features: int
    std_errors: list[float]
    t_stats: list[float]
    p_values: list[float]
    ci95: list[tuple[float, float]]
    df: int
    sigma2: float
    f_stat: float
    f_p_value: float
    method: str = "OLS"
    dropped_features: list[DroppedFeatureSchema] | None = None
    # ── Campos específicos de RLS (ausentes en OLS) ───────────────────────────
    rls_constraint: str | None = None
    rss_ols: float | None = Field(default=None, alias="rssOLS")
    rss_rls: float | None = Field(default=None, alias="rssRLS")
    f_stat_constraint: float | None = None
    f_p_value_constraint: float | None = None
    j_constraints: int | None = None
    restricted_inference_available: bool | None = None
