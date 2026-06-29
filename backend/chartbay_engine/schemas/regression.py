"""Contratos de la API de regresión (espejan `RegressionResult` del frontend TS)."""

from __future__ import annotations

from pydantic import Field, model_validator

from chartbay_engine.schemas.common import CamelModel


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
        if not self.y:
            raise ValueError("y no puede estar vacío.")
        if not self.x:
            raise ValueError("X no puede estar vacío.")
        n_cols = len(self.x[0])
        if any(len(row) != n_cols for row in self.x):
            raise ValueError("Todas las filas de X deben tener la misma cantidad de columnas.")
        if len(self.x) != len(self.y):
            raise ValueError(
                f"X tiene {len(self.x)} filas pero y tiene {len(self.y)} valores."
            )
        if len(self.feature_names) != n_cols:
            raise ValueError(
                f"featureNames tiene {len(self.feature_names)} nombres pero X tiene "
                f"{n_cols} columna(s)."
            )
        return self


class DroppedFeatureSchema(CamelModel):
    name: str
    reason: str


class RegressionResult(CamelModel):
    """Resultado de una regresión (OLS o RLS). Serializa en camelCase."""

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
