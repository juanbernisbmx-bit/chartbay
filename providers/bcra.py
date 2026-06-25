"""
Proveedor BCRA (Banco Central de la República Argentina) — PENDIENTE.

Plantilla lista para implementar. La API de estadísticas del BCRA entrega
series con fecha y valor; al implementarla, mapear su respuesta a `Series`
usando `normalize_observations` y devolver el mismo formato estándar.
"""
from __future__ import annotations

from .base import BaseProvider, ProviderError, Series


class BcraProvider(BaseProvider):
    code = "bcra"
    name = "BCRA — Banco Central de la República Argentina"
    implemented = False

    def fetch(self, series_id: str, *, country: str = "Argentina", name: str = "", **opts) -> Series:
        raise ProviderError("El proveedor BCRA todavía no está implementado.")
