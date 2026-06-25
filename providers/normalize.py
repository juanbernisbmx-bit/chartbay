"""
Normalización: deja TODAS las series en el mismo formato limpio,
independientemente de cómo las entregue cada fuente.

Reglas (las que pidió el contrato):
- Fechas en ISO-8601 (YYYY-MM-DD).
- Sin filas vacías ni valores faltantes (se descartan).
- Orden cronológico ascendente.
- Valores numéricos (float); los marcadores de faltante ('.', '', 'NA'...) se omiten.
"""
from __future__ import annotations

from datetime import datetime
from typing import Iterable, Optional

from .base import Observation

_MISSING = {"", ".", "na", "nan", "null", "none", "-", "n/a"}
_DATE_FORMATS = ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y", "%Y-%m", "%Y")


def to_iso_date(raw: str) -> Optional[str]:
    """Convierte una fecha en cualquier formato conocido a ISO; None si no se puede."""
    raw = (raw or "").strip()
    if not raw:
        return None
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    return None


def to_float(raw) -> Optional[float]:
    """Parsea un valor a float; None si está vacío o es un marcador de faltante."""
    if raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    s = str(raw).strip().replace(",", "")
    if s.lower() in _MISSING:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def normalize_observations(rows: Iterable[dict], *, date_key: str = "date",
                           value_key: str = "value", drop_missing: bool = True) -> list[Observation]:
    """Toma filas crudas {date, value} de cualquier fuente y devuelve
    una lista limpia y ordenada de `Observation`."""
    out: list[Observation] = []
    for row in rows:
        iso = to_iso_date(str(row.get(date_key, "")))
        if iso is None:
            continue
        val = to_float(row.get(value_key))
        if val is None and drop_missing:
            continue
        out.append(Observation(date=iso, value=val))
    out.sort(key=lambda o: o.date)
    return out
