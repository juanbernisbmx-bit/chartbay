"""Tipos que se pasan entre las etapas del IPC: colector -> parser -> validación.

Contrato compartido (ver servicio_datos/COORDINACION.md). Quien necesite
cambiarlo lo avisa en COORDINACION.md antes de tocarlo.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path


@dataclass(frozen=True)
class DescargaRegistrada:
    """Un archivo ya guardado en el crudo y registrado en la tabla `descarga`."""

    id: int
    clave: str  # 'nacional' | 'aperturas' (ArchivoFuente.clave)
    url: str
    sha256: str
    ruta: Path  # absoluta; el archivo existe y no se modifica
    estado: str  # 'nueva' | 'identica'
    publicada_en: datetime | None  # Last-Modified del servidor


@dataclass(frozen=True)
class SerieLeida:
    """Una serie ya extraída del archivo, lista para validar."""

    serie_id: str
    archivo: str  # ArchivoFuente.clave
    hoja: str
    fila_origen: int  # 1-based, la fila "Nivel general" de donde salen los valores
    # (primer día del mes, valor), en orden cronológico, sin repetidos.
    # El valor es Decimal(str(float)): 101.5859 queda 101.5859 y no 101.58590000000001.
    observaciones: tuple[tuple[date, Decimal], ...]
    notas: tuple[str, ...]  # p. ej. "Encabezado 2026-03-26 interpretado como período mensual 2026-03"


@dataclass(frozen=True)
class Hallazgo:
    """Lo que la validación (o el agente) marca para que lo mire una persona."""

    regla: str  # 'cobertura', 'historia_intacta', 'salto_mensual', ...
    severidad: str  # 'baja' | 'media' | 'alta'
    serie_id: str | None
    periodo: date | None
    detalle: str
