"""
Proveedor IMF (International Monetary Fund — IFS / SDMX) — PENDIENTE.

Plantilla lista para implementar. El FMI expone datos vía su API SDMX-JSON;
al implementarlo, mapear su respuesta a `Series` con `normalize_observations`
y devolver el mismo formato estándar que el resto de los proveedores.
"""
from __future__ import annotations

from .base import BaseProvider, ProviderError, Series


class ImfProvider(BaseProvider):
    code = "imf"
    name = "IMF — International Monetary Fund"
    implemented = False

    def fetch(self, series_id: str, *, country: str = "", name: str = "", **opts) -> Series:
        raise ProviderError("El proveedor IMF todavía no está implementado.")
