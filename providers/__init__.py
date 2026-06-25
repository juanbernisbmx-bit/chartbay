"""
Paquete de proveedores de datos macroeconómicos.

Punto de entrada único para el resto de la app. El registro `_PROVIDERS`
desacopla el sistema de cualquier fuente concreta: agregar IMF/OECD/etc. es
sólo implementar su clase y sumarla acá.

Uso típico desde Flask:
    import providers
    series = providers.fetch_series("us_cpi")     # -> Series normalizada
    csv = providers.to_csv(series)
"""
from __future__ import annotations

from .base import (
    BaseProvider,
    Observation,
    ProviderError,
    ProviderHTTPError,
    Series,
)
from .bcra import BcraProvider
from .catalog import CATALOG, CATEGORIES, Indicator, catalog_public, get_indicator
from .exporters import (
    EXPORT_FORMATS,
    series_from_json,
    to_csv,
    to_json,
    to_json_str,
)
from .fred import FredProvider
from .imf import ImfProvider
from .normalize import normalize_observations
from .oecd import OecdProvider
from .worldbank import WorldBankProvider

# Registro de proveedores. Para sumar una fuente: instanciarla aquí.
_PROVIDERS: dict[str, BaseProvider] = {
    p.code: p
    for p in (
        FredProvider(),
        BcraProvider(),
        WorldBankProvider(),
        OecdProvider(),
        ImfProvider(),
    )
}


def get_provider(code: str) -> BaseProvider | None:
    return _PROVIDERS.get(code)


def provider_status() -> list[dict]:
    """Estado de cada fuente, para informar disponibilidad y 'próximamente'."""
    return [
        {
            "code": code,
            "name": p.name,
            "implemented": p.implemented,
            "available": p.available(),
            "requires_key": p.requires_key,
        }
        for code, p in _PROVIDERS.items()
    ]


def _resolve(indicator_id: str):
    ind = get_indicator(indicator_id)
    if not ind:
        raise ProviderError(f"Indicador desconocido: {indicator_id}")
    provider = get_provider(ind.provider)
    if not provider:
        raise ProviderError(f"Proveedor no registrado: {ind.provider}")
    return ind, provider


def fetch_series(indicator_id: str) -> Series:
    """Descarga + normaliza la serie de un indicador del catálogo."""
    ind, provider = _resolve(indicator_id)
    return provider.fetch(ind.series_id, country=ind.country, name=ind.name)


def latest_observation(indicator_id: str) -> Observation | None:
    """Última observación de un indicador (para 'última actualización')."""
    ind, provider = _resolve(indicator_id)
    return provider.latest(ind.series_id)


__all__ = [
    "BaseProvider", "Observation", "ProviderError", "ProviderHTTPError", "Series",
    "Indicator", "CATALOG", "CATEGORIES", "catalog_public", "get_indicator",
    "EXPORT_FORMATS", "series_from_json", "to_csv", "to_json", "to_json_str",
    "normalize_observations",
    "get_provider", "provider_status", "fetch_series", "latest_observation",
]
