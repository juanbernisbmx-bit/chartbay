"""
Proveedor OECD (OECD.Stat / SDMX) — PENDIENTE.

Plantilla lista para implementar. La OCDE expone datos vía SDMX-JSON; al
implementarlo, mapear su respuesta a `Series` con `normalize_observations`
y devolver el mismo formato estándar que el resto de los proveedores.
"""
from __future__ import annotations

from .base import BaseProvider, ProviderError, Series


class OecdProvider(BaseProvider):
    code = "oecd"
    name = "OECD — Organisation for Economic Co-operation and Development"
    implemented = False

    def fetch(self, series_id: str, *, country: str = "", name: str = "", **opts) -> Series:
        raise ProviderError("El proveedor OECD todavía no está implementado.")
