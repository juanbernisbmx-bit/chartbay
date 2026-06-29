"""Respuesta JSON tolerante a valores no finitos.

JSON no representa ``Infinity``/``NaN`` y Starlette serializa con ``allow_nan=False``, por lo
que un float no finito (p. ej. el F global de un ajuste perfecto, o un t-stat con error
estándar nulo) provocaría un 500. Esta respuesta los convierte a ``null`` antes de serializar.
"""

from __future__ import annotations

import math
from typing import Any

from fastapi.responses import JSONResponse


def to_json_safe(value: Any) -> Any:
    """Reemplaza recursivamente floats no finitos (inf/-inf/NaN) por ``None``."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: to_json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_json_safe(item) for item in value]
    return value


class SafeJSONResponse(JSONResponse):
    def render(self, content: Any) -> bytes:
        return super().render(to_json_safe(content))
