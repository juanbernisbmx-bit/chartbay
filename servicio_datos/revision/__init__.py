"""Interfaz de revisión de candidatos. `crear_app` arma la app Flask; `python -m servicio_datos.revision` la sirve."""
from servicio_datos.revision.app import crear_app

__all__ = ["crear_app"]
