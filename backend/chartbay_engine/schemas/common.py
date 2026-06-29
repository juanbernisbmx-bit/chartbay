"""Base común de los esquemas: alias camelCase para espejar las interfaces TS del frontend.

Las respuestas se serializan con alias (FastAPI usa ``by_alias=True`` por defecto), así el
JSON sale en camelCase (``rSquared``, ``stdErrors``, …) y el frontend puede migrar de
``runOLS(...)`` a ``fetch(...)`` con cambios mínimos (ADR-2). ``populate_by_name=True``
permite además poblar los modelos usando los nombres snake_case de Python.
"""

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        from_attributes=True,  # permite construir el schema desde dataclasses del core
    )
