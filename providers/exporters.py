"""
Exportadores: convierten una `Series` normalizada a distintos formatos.

Hoy: CSV y JSON. La estructura `EXPORT_FORMATS` está preparada para sumar
Excel (xlsx) más adelante sin tocar las rutas: basta registrar un formato.
"""
from __future__ import annotations

import json
from typing import Optional

from .base import Observation, Series


def _num(value: Optional[float]) -> str:
    """Representación numérica limpia: enteros sin '.0', decimales sin ruido."""
    if value is None:
        return ""
    f = float(value)
    if f.is_integer():
        return str(int(f))
    return repr(f)


def to_csv(series: Series) -> str:
    """CSV limpio: encabezado `date,value`, fechas ISO, sin filas vacías ni notas al pie."""
    lines = ["date,value"]
    for o in series.observations:
        if o.value is None:
            continue
        lines.append(f"{o.date},{_num(o.value)}")
    return "\n".join(lines) + "\n"


def to_json(series: Series) -> dict:
    """Formato estándar {name, country, frequency, observations} + metadata."""
    return {
        "name": series.name,
        "country": series.country,
        "frequency": series.frequency,
        "source": series.source,
        "series_id": series.series_id,
        "units": series.units,
        "last_updated": series.last_updated,
        "observations": [{"date": o.date, "value": o.value} for o in series.observations],
    }


def to_json_str(series: Series) -> str:
    return json.dumps(to_json(series), ensure_ascii=False, indent=2)


def series_from_json(d: dict) -> Series:
    """Reconstruye una `Series` desde el dict de `to_json` (usado por la caché)."""
    return Series(
        name=d.get("name", ""),
        country=d.get("country", ""),
        frequency=d.get("frequency", ""),
        observations=[Observation(o["date"], o["value"]) for o in d.get("observations", [])],
        source=d.get("source", ""),
        series_id=d.get("series_id", ""),
        units=d.get("units", ""),
    )


# fmt -> cómo servir la descarga. Para sumar Excel: agregar aquí una entrada
# "xlsx" con su render (requerirá openpyxl). Las rutas no cambian.
EXPORT_FORMATS = {
    "csv": {"mimetype": "text/csv; charset=utf-8", "ext": "csv", "render": to_csv},
    "json": {"mimetype": "application/json; charset=utf-8", "ext": "json", "render": to_json_str},
    # "xlsx": {"mimetype": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    #          "ext": "xlsx", "render": to_xlsx},  # TODO: pendiente (openpyxl)
}
