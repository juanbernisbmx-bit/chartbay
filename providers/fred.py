"""
Proveedor FRED (Federal Reserve Economic Data, St. Louis Fed).

Requiere una API key gratuita: https://fredaccount.stlouisfed.org/apikeys
Se lee de la variable de entorno FRED_API_KEY. El usuario final nunca la ve:
es un secreto de despliegue, igual que ANTHROPIC_API_KEY.
"""
from __future__ import annotations

import os
from typing import Optional

from ._http import get_json
from .base import BaseProvider, Observation, ProviderError, Series
from .normalize import normalize_observations

# FRED `frequency_short` -> etiqueta canónica en español.
_FREQ = {
    "D": "Diaria", "W": "Semanal", "BW": "Quincenal",
    "M": "Mensual", "Q": "Trimestral", "SA": "Semestral", "A": "Anual",
}


class FredProvider(BaseProvider):
    code = "fred"
    name = "FRED — Federal Reserve Economic Data"
    requires_key = True
    BASE = "https://api.stlouisfed.org/fred"

    def __init__(self, api_key: Optional[str] = None):
        # Si no se pasa explícita, se resuelve del entorno en cada uso (robusto
        # frente al orden de carga del .env).
        self._explicit_key = api_key

    def _key(self) -> str:
        return self._explicit_key or os.environ.get("FRED_API_KEY", "")

    def available(self) -> bool:
        return bool(self._key())

    def _params(self, **extra) -> dict:
        return {"api_key": self._key(), "file_type": "json", **extra}

    def _require_key(self) -> None:
        if not self.available():
            raise ProviderError(
                "Falta FRED_API_KEY. Conseguí una gratis en "
                "https://fredaccount.stlouisfed.org/apikeys y agregala al .env"
            )

    def _series_meta(self, series_id: str) -> dict:
        data = get_json(f"{self.BASE}/series", self._params(series_id=series_id))
        items = data.get("seriess") or []
        if not items:
            raise ProviderError(f"FRED no reconoce la serie '{series_id}'")
        return items[0]

    def fetch(self, series_id: str, *, country: str = "", name: str = "", **opts) -> Series:
        self._require_key()
        meta = self._series_meta(series_id)
        data = get_json(f"{self.BASE}/series/observations", self._params(series_id=series_id))
        obs = normalize_observations(data.get("observations", []))
        return Series(
            name=name or meta.get("title", series_id),
            country=country,
            frequency=_FREQ.get(meta.get("frequency_short", ""), meta.get("frequency", "")),
            observations=obs,
            source="FRED",
            series_id=series_id,
            units=meta.get("units", ""),
        )

    def latest(self, series_id: str) -> Optional[Observation]:
        """Trae sólo la última observación (barato, para 'última actualización')."""
        self._require_key()
        data = get_json(
            f"{self.BASE}/series/observations",
            self._params(series_id=series_id, sort_order="desc", limit=1),
        )
        obs = normalize_observations(data.get("observations", []))
        return obs[0] if obs else None
