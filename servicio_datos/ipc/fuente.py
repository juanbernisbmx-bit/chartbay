"""Fuente INDEC_IPC: dónde están los archivos, cómo se llaman y qué trae cada uno.

Verificado contra el servidor de INDEC el 2026-10-06:

- `sh_ipc_MM_AA.xls` lleva el mes de PUBLICACIÓN, no el del dato. El de agosto
  (`08_26`, publicado el 13/08) trae datos hasta julio.
- `sh_ipc_aperturas.xls` tiene nombre fijo y se pisa en cada publicación.
- Un archivo que no existe NO da 404: INDEC responde 200 con una página HTML
  (`sh_ipc_10_26.xls` el 2026-10-06). Hay que mirar el contenido, no el estado.
- El servidor manda `Last-Modified`: es la fecha de publicación del archivo.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Mapping

FUENTE_ID = "INDEC_IPC"
FUENTE_NOMBRE = "INDEC"
URL_BASE = "https://www.indec.gob.ar/ftp/cuadros/economia/"
URL_PUBLICACION = "https://www.indec.gob.ar/indec/web/Nivel4-Tema-3-5-31"
HOST = "www.indec.gob.ar"

REGIONES: Mapping[str, str] = {
    "Región GBA": "ipc_ng_gba",
    "Región Pampeana": "ipc_ng_pampeana",
    "Región Noroeste": "ipc_ng_noa",
    "Región Noreste": "ipc_ng_nea",
    "Región Cuyo": "ipc_ng_cuyo",
    "Región Patagonia": "ipc_ng_patagonia",
}


@dataclass(frozen=True)
class ArchivoFuente:
    clave: str
    hoja: str
    # Rótulo de la primera columna de la hoja -> id de serie.
    series: Mapping[str, str]
    # Nombres posibles, del más nuevo al más viejo.
    nombres: tuple[str, ...]

    def urls_candidatas(self) -> tuple[str, ...]:
        return tuple(URL_BASE + nombre for nombre in self.nombres)


def nombres_nacional(hoy: date, meses_atras: int = 3) -> tuple[str, ...]:
    """`sh_ipc_MM_AA.xls` del mes de `hoy` hacia atrás, el más nuevo primero."""
    nombres = []
    anio, mes = hoy.year, hoy.month
    for _ in range(meses_atras):
        nombres.append(f"sh_ipc_{mes:02d}_{anio % 100:02d}.xls")
        mes -= 1
        if mes == 0:
            anio, mes = anio - 1, 12
    return tuple(nombres)


def archivos(hoy: date) -> tuple[ArchivoFuente, ...]:
    return (
        ArchivoFuente(
            clave="nacional",
            hoja="Índices IPC Cobertura Nacional",
            series={"Total nacional": "ipc_ng_nacional"},
            nombres=nombres_nacional(hoy),
        ),
        ArchivoFuente(
            clave="aperturas",
            hoja="Índices aperturas",
            series=REGIONES,
            nombres=("sh_ipc_aperturas.xls",),
        ),
    )
