"""Errores de dominio del motor.

El núcleo (`core`) levanta estas excepciones ante entradas inválidas o modelos no
estimables. La capa API las traduce a HTTP 422 con un cuerpo estructurado
``{error, code, details}`` (ver `chartbay_engine.main`). El núcleo no conoce HTTP.
"""

from __future__ import annotations

from typing import Any


class EngineError(ValueError):
    """Error de dominio: entrada inválida o modelo no estimable."""

    code: str = "engine_error"

    def __init__(
        self,
        message: str,
        *,
        code: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        if code is not None:
            self.code = code
        self.details: dict[str, Any] = details or {}


class InvalidInputError(EngineError):
    code = "invalid_input"


class InsufficientObservationsError(EngineError):
    code = "insufficient_observations"


class RankDeficiencyError(EngineError):
    code = "rank_deficiency"


class ConstraintError(EngineError):
    """Restricción lineal (RLS) inválida o inconsistente con el modelo."""

    code = "invalid_constraint"
