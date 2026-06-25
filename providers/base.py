"""
Contrato común para todos los proveedores de datos macroeconómicos.

Cada proveedor (FRED, BCRA, World Bank, OECD, IMF) implementa `BaseProvider`
y devuelve SIEMPRE un objeto `Series` con la misma forma. Así, las capas
superiores (rutas Flask, exportadores, frontend) nunca necesitan saber de qué
fuente provienen los datos: el sistema no está acoplado a FRED.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


class ProviderError(Exception):
    """Error de dominio de un proveedor (símbolo inválido, falta API key, etc.)."""


class ProviderHTTPError(ProviderError):
    """Fallo de red o respuesta HTTP no satisfactoria al consultar la fuente."""


@dataclass(frozen=True)
class Observation:
    """Un punto de la serie. `date` siempre en ISO-8601 (YYYY-MM-DD)."""
    date: str
    value: Optional[float]


@dataclass
class Series:
    """
    Formato estándar que devuelven TODOS los proveedores.

    Campos del contrato pedido: name, country, frequency, observations.
    El resto es metadata opcional útil para trazabilidad y exportación.
    """
    name: str
    country: str
    frequency: str
    observations: list[Observation] = field(default_factory=list)
    source: str = ""
    series_id: str = ""
    units: str = ""
    notes: str = ""

    @property
    def last_updated(self) -> Optional[str]:
        return self.observations[-1].date if self.observations else None


class BaseProvider(ABC):
    """
    Interfaz que debe cumplir cada proveedor para sumarse al sistema.

    Para agregar una fuente nueva basta con: subclasear esto, implementar
    `fetch`, y registrar la instancia en `providers/__init__.py`. Nada más
    del sistema cambia.
    """
    code: str = ""            # identificador corto: 'fred', 'bcra', ...
    name: str = ""            # nombre legible de la fuente
    requires_key: bool = False
    implemented: bool = True

    @abstractmethod
    def fetch(self, series_id: str, *, country: str = "", name: str = "", **opts) -> Series:
        """Descarga la serie completa y la devuelve normalizada como `Series`."""
        ...

    def latest(self, series_id: str) -> Optional[Observation]:
        """Última observación. Por defecto reusa `fetch`; los proveedores
        pueden sobreescribirlo con una llamada más barata."""
        s = self.fetch(series_id)
        return s.observations[-1] if s.observations else None

    def available(self) -> bool:
        """True si el proveedor está listo para usarse (p.ej. tiene API key)."""
        return self.implemented
