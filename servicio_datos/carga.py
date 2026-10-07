"""La validación del IPC y la carga del candidato, desde Python (la lógica está en la base: migración 0011).

Arma la carga que espera `cargar_candidato` a partir de lo que leyó el parser, y traduce sus errores. Es lo mismo que va a
mandar la Edge Function de la colecta, así que sirve también para comparar las dos implementaciones de la validación.
"""
from __future__ import annotations

from typing import Iterable, Mapping

import psycopg
from psycopg.types.json import Jsonb

from servicio_datos.ipc import fuente
from servicio_datos.ipc.modelos import DescargaRegistrada, Hallazgo, SerieLeida
from servicio_datos.publicacion import _llamar


def carga_de(series: Mapping[str, SerieLeida], descargados: Iterable[DescargaRegistrada | str] = (),
             definiciones: Mapping[str, Mapping[str, str]] = fuente.SERIES) -> dict:
    """La carga para la base: las series con sus valores como texto (sin perder decimales), sus definiciones y qué se bajó."""
    return {
        "series": [{"serie_id": s.serie_id, "archivo": s.archivo, "hoja": s.hoja, "fila_origen": s.fila_origen,
                    "observaciones": [[p.isoformat(), str(v)] for p, v in s.observaciones], "notas": list(s.notas)}
                   for s in series.values()],
        "definiciones": {serie_id: dict(d) for serie_id, d in definiciones.items()},
        "descargados": sorted({d if isinstance(d, str) else d.clave for d in descargados}),
    }


def validar(conn: psycopg.Connection, series: Mapping[str, SerieLeida], descargados: Iterable[DescargaRegistrada | str], hoy) -> list[Hallazgo]:
    """Los hallazgos de `validar_ipc`, en el orden en que los emite. Lo vigente lo lee de la base."""
    carga = carga_de(series, descargados)
    filas = _llamar(conn, "SELECT regla, severidad, serie_id, periodo, detalle FROM validar_ipc(%s, %s, %s) ORDER BY orden",
                    (Jsonb(carga["series"]), hoy, carga["descargados"])).fetchall()
    return [Hallazgo(*fila) for fila in filas]


def cargar_candidato(conn: psycopg.Connection, corrida_id: int, hoy, series: Mapping[str, SerieLeida],
                     descargados: Iterable[DescargaRegistrada | str], definiciones: Mapping[str, Mapping[str, str]] = fuente.SERIES) -> dict:
    """Compara, valida y deja el candidato (o cierra la corrida sin cambios). Devuelve lo que devuelve la base."""
    return _llamar(conn, "SELECT cargar_candidato(%s, %s, %s)", (corrida_id, hoy, Jsonb(carga_de(series, descargados, definiciones)))).fetchone()[0]
