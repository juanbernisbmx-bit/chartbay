"""Lecturas y escrituras de la base que usa el colector. Sin lógica de negocio."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Mapping, NamedTuple

import psycopg
from psycopg.types.json import Jsonb


class DescargaConocida(NamedTuple):
    sha256: str
    ruta_crudo: str


def asegurar_fuente(conn: psycopg.Connection, id: str, nombre: str, url_base: str) -> None:
    conn.execute(
        "INSERT INTO fuente (id, nombre, url_base) VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING",
        (id, nombre, url_base),
    )


def abrir_corrida_exclusiva(conn: psycopg.Connection, fuente_id: str, vencimiento_segundos: float) -> int | None:
    """Abre una corrida, o devuelve None si ya hay otra en curso para la fuente.

    Una corrida `en_curso` más vieja que el vencimiento se da por abandonada
    (el proceso murió a mitad de camino) y se cierra como fallida: si no, una
    caída dejaría la fuente bloqueada para siempre.
    """
    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("colector:" + fuente_id,))
        conn.execute(
            "UPDATE corrida SET estado = 'fallida', terminada_en = now(), "
            "error = 'Abandonada: quedó en curso más allá del vencimiento' "
            "WHERE fuente_id = %s AND estado = 'en_curso' "
            "AND iniciada_en < now() - make_interval(secs => %s::float8)",
            (fuente_id, vencimiento_segundos),
        )
        if conn.execute(
            "SELECT 1 FROM corrida WHERE fuente_id = %s AND estado = 'en_curso'", (fuente_id,)
        ).fetchone():
            return None
        return conn.execute(
            "INSERT INTO corrida (fuente_id, estado) VALUES (%s, 'en_curso') RETURNING id", (fuente_id,)
        ).fetchone()[0]


def ultima_conocida(conn: psycopg.Connection, url: str) -> DescargaConocida | None:
    """La última descarga de esa URL que una corrida terminada dio por buena.

    Las de corridas fallidas o todavía en curso no cuentan: si una corrida se cae
    a mitad de camino, la próxima tiene que volver a ver ese archivo como nuevo.
    """
    fila = conn.execute(
        "SELECT d.sha256, d.ruta_crudo FROM descarga d "
        "JOIN corrida_descarga cd ON cd.descarga_id = d.id "
        "JOIN corrida c ON c.id = cd.corrida_id "
        "WHERE d.url = %s AND d.estado IN ('nueva', 'identica') "
        "AND c.estado IN ('con_candidato', 'sin_cambios') "
        "ORDER BY d.descargada_en DESC, d.id DESC LIMIT 1",
        (url,),
    ).fetchone()
    return DescargaConocida(*fila) if fila else None


def registrar_descarga(
    conn: psycopg.Connection,
    corrida_id: int,
    fuente_id: str,
    url: str,
    estado: str,
    *,
    sha256: str | None = None,
    bytes: int | None = None,
    ruta_crudo: str | None = None,
    publicada_en: datetime | None = None,
    error: str | None = None,
) -> int:
    with conn.transaction():
        descarga_id = conn.execute(
            "INSERT INTO descarga (fuente_id, url, sha256, bytes, ruta_crudo, publicada_en, estado, error) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (fuente_id, url, sha256, bytes, ruta_crudo, publicada_en, estado, error),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO corrida_descarga (corrida_id, descarga_id) VALUES (%s, %s)", (corrida_id, descarga_id)
        )
    return descarga_id


def cerrar_corrida(
    conn: psycopg.Connection, corrida_id: int, estado: str, error: str | None = None, resumen: dict | None = None
) -> None:
    conn.execute(
        "UPDATE corrida SET estado = %s, terminada_en = now(), error = %s, "
        "resumen = resumen || coalesce(%s::jsonb, '{}'::jsonb) WHERE id = %s AND estado = 'en_curso'",
        (estado, error, Jsonb(resumen) if resumen is not None else None, corrida_id),
    )


def guardar_resumen(conn: psycopg.Connection, corrida_id: int, resumen: dict) -> None:
    conn.execute("UPDATE corrida SET resumen = %s WHERE id = %s", (Jsonb(resumen), corrida_id))


# --- Lo que usa el pipeline para armar un candidato -------------------------


def asegurar_series(
    conn: psycopg.Connection, fuente_id: str, definiciones: Mapping[str, Mapping[str, str]],
    origenes: Mapping[str, tuple[str, int]],
) -> set[str]:
    """Crea las series que falten y devuelve los ids que existen después.

    Una serie ya creada no se toca: sus datos descriptivos son del catálogo, no de cada corrida.
    """
    for serie_id, d in definiciones.items():
        hoja, fila = origenes.get(serie_id, (None, None))
        conn.execute(
            "INSERT INTO serie (id, fuente_id, nombre, tema, nivel, territorio, clasificacion, frecuencia, "
            "unidad, base, hoja_origen, fila_origen) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO NOTHING",
            (serie_id, fuente_id, d["nombre"], d["tema"], d["nivel"], d["territorio"], d["clasificacion"],
             d["frecuencia"], d["unidad"], d["base"], hoja, fila),
        )
    return {fila[0] for fila in conn.execute("SELECT id FROM serie WHERE fuente_id = %s", (fuente_id,))}


def vigentes(conn: psycopg.Connection, fuente_id: str) -> dict[str, dict[date, Decimal]]:
    """Las observaciones del último release publicado, por serie y período."""
    resultado: dict[str, dict[date, Decimal]] = {}
    for serie_id, periodo, valor in conn.execute(
        "SELECT o.serie_id, o.periodo, o.valor FROM observacion_vigente o "
        "JOIN serie s ON s.id = o.serie_id WHERE s.fuente_id = %s",
        (fuente_id,),
    ):
        resultado.setdefault(serie_id, {})[periodo] = valor
    return resultado


def hallazgos_revisados(conn: psycopg.Connection, fuente_id: str) -> set[tuple]:
    """Hallazgos que ya pasaron por una publicación: alguien los vio y aprobó el release.

    Se acumulan sobre todos los releases de la fuente: cada corrida solo guarda lo que
    era nuevo para ella, así que mirar solo el último olvidaría lo aprobado antes.
    """
    return {
        tuple(fila)
        for fila in conn.execute(
            "SELECT h.regla, h.serie_id, h.periodo, h.detalle FROM hallazgo h WHERE h.corrida_id IN ("
            " SELECT c.corrida_id FROM release r JOIN candidato c ON c.id = r.candidato_id "
            " JOIN corrida co ON co.id = c.corrida_id WHERE co.fuente_id = %s)",
            (fuente_id,),
        )
    }


def descartar_candidatos_abiertos(conn: psycopg.Connection, fuente_id: str) -> list[int]:
    """Cierra como descartados los candidatos que esperaban revisión y quedaron viejos."""
    return [
        fila[0]
        for fila in conn.execute(
            "UPDATE candidato SET estado = 'descartado', decidido_en = now(), decidido_por = 'sistema' "
            "WHERE estado = 'abierto' AND corrida_id IN (SELECT id FROM corrida WHERE fuente_id = %s) "
            "RETURNING id",
            (fuente_id,),
        )
    ]


def crear_candidato(conn: psycopg.Connection, corrida_id: int) -> int:
    return conn.execute("INSERT INTO candidato (corrida_id) VALUES (%s) RETURNING id", (corrida_id,)).fetchone()[0]


def guardar_observaciones_candidatas(conn: psycopg.Connection, candidato_id: int, filas: list[tuple]) -> None:
    """`filas`: (serie_id, periodo, valor). Guarda el candidato completo, no solo la diferencia."""
    with conn.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO observacion_candidata (candidato_id, serie_id, periodo, valor) VALUES (%s, %s, %s, %s)",
            [(candidato_id, serie_id, periodo, valor) for serie_id, periodo, valor in filas],
        )


def guardar_hallazgos(conn: psycopg.Connection, corrida_id: int, hallazgos: list[tuple]) -> None:
    """`hallazgos`: (serie_id | None, periodo | None, regla, severidad, detalle)."""
    with conn.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO hallazgo (corrida_id, serie_id, periodo, regla, severidad, detalle) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            [(corrida_id, *h) for h in hallazgos],
        )
