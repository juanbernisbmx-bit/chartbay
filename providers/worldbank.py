"""
Proveedor World Bank (World Development Indicators).
API pública — NO requiere API key.
Endpoint: https://api.worldbank.org/v2/country/{ISO3}/indicator/{CODE}?format=json

El `series_id` en el catálogo tiene el formato "ISO3/INDICATOR_CODE",
por ejemplo "ARG/FP.CPI.TOTL.ZG". Así el proveedor sabe tanto el país
como el indicador sin parámetros extra.
"""
from __future__ import annotations

from typing import Optional

from ._http import get_json
from .base import BaseProvider, Observation, ProviderError, Series
from .normalize import normalize_observations, to_float

BASE = "https://api.worldbank.org/v2"

_FREQ_MAP = {
    "Annual": "Anual",
    "Quarterly": "Trimestral",
    "Monthly": "Mensual",
}


def _wb_date_to_iso(raw: str) -> str:
    """
    Convierte formatos de fecha del Banco Mundial a ISO-8601:
      "2023"   → "2023-01-01"  (anual)
      "2023Q1" → "2023-01-01"  (trimestral)
      "2023M01"→ "2023-01-01"  (mensual)
    """
    raw = raw.strip()
    if "Q" in raw:
        year, q = raw.split("Q", 1)
        month = (int(q) - 1) * 3 + 1
        return f"{year}-{month:02d}-01"
    if "M" in raw:
        year, m = raw.split("M", 1)
        return f"{year}-{m.zfill(2)}-01"
    if len(raw) == 4 and raw.isdigit():
        return f"{raw}-01-01"
    return raw


def _infer_freq(date_str: str) -> str:
    if "Q" in date_str:
        return "Trimestral"
    if "M" in date_str:
        return "Mensual"
    return "Anual"


class WorldBankProvider(BaseProvider):
    code = "worldbank"
    name = "World Bank — World Development Indicators"
    implemented = True

    def _fetch_raw(self, iso3: str, indicator: str, params: dict) -> list:
        url = f"{BASE}/country/{iso3}/indicator/{indicator}"
        data = get_json(url, {"format": "json", **params})
        if not isinstance(data, list) or len(data) < 2:
            raise ProviderError(
                f"Respuesta inesperada de World Bank para '{iso3}/{indicator}'"
            )
        return data

    def fetch(self, series_id: str, *, country: str = "", name: str = "", **opts) -> Series:
        try:
            iso3, indicator = series_id.split("/", 1)
        except ValueError:
            raise ProviderError(
                f"series_id de World Bank debe ser 'ISO3/INDICATOR_CODE', recibí: '{series_id}'"
            )

        data = self._fetch_raw(iso3, indicator, {"per_page": "20000"})
        obs_raw = data[1]

        if not obs_raw:
            raise ProviderError(
                f"World Bank no tiene observaciones para '{series_id}'"
            )

        # Inferir frecuencia del primer registro
        freq = _FREQ_MAP.get(_infer_freq(obs_raw[0].get("date", "")), "Anual")

        # Pre-convertir fechas WB a ISO antes de pasar al normalizador
        rows = [
            {"date": _wb_date_to_iso(o["date"]), "value": o.get("value")}
            for o in obs_raw
            if o.get("date")
        ]
        obs = normalize_observations(rows)

        return Series(
            name=name or f"{iso3} — {indicator}",
            country=country or iso3,
            frequency=freq,
            observations=obs,
            source="World Bank",
            series_id=series_id,
            units=opts.get("units", ""),
        )

    def latest(self, series_id: str) -> Optional[Observation]:
        """Trae sólo la última observación disponible (barato: mrv=1)."""
        try:
            iso3, indicator = series_id.split("/", 1)
        except ValueError:
            return None

        try:
            data = self._fetch_raw(iso3, indicator, {"mrv": "1", "per_page": "1"})
        except ProviderError:
            return None

        obs_raw = data[1]
        if not obs_raw:
            return None

        o = obs_raw[0]
        date = _wb_date_to_iso(o.get("date", ""))
        value = to_float(o.get("value"))
        if not date or value is None:
            return None
        return Observation(date=date, value=value)
