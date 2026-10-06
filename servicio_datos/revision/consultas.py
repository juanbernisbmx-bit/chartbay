"""Lo que la interfaz de revisión necesita leer. Solo lecturas; las acciones están en `publicacion`."""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any, Sequence

import psycopg
from psycopg.rows import dict_row

Fila = dict[str, Any]

# La última decisión de cada hallazgo: es la que vale (ver migración 0003).
_ULTIMA_DECISION = (
    "LEFT JOIN LATERAL (SELECT decision FROM revision_hallazgo r WHERE r.hallazgo_id = h.id "
    " ORDER BY r.id DESC LIMIT 1) u ON true"
)


def _filas(conn: psycopg.Connection, sql: str, params: Sequence | dict = ()) -> list[Fila]:
    with conn.cursor(row_factory=dict_row) as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def _fila(conn: psycopg.Connection, sql: str, params: Sequence | dict = ()) -> Fila | None:
    filas = _filas(conn, sql, params)
    return filas[0] if filas else None


def resumen(conn: psycopg.Connection) -> Fila:
    """Las cuatro tarjetas de la cola."""
    return {
        "esperan_revision": conn.execute("SELECT count(*) FROM candidato WHERE estado = 'abierto'").fetchone()[0],
        "fallidas": len(corridas_fallidas(conn)),
        "release": _fila(conn, "SELECT r.numero, r.release_id, r.publicado_en, r.aprobado_por FROM release r ORDER BY r.numero DESC LIMIT 1"),
        "ultima_corrida": _fila(conn, "SELECT id, estado, iniciada_en, terminada_en, fuente_id FROM corrida ORDER BY id DESC LIMIT 1"),
    }


def candidatos_abiertos(conn: psycopg.Connection) -> list[Fila]:
    """Candidatos esperando revisión, del más viejo al más nuevo, con cuántos hallazgos faltan."""
    return _filas(
        conn,
        "SELECT c.id, c.creado_en, c.corrida_id, co.fuente_id, co.resumen, count(h.id) AS hallazgos, "
        " count(*) FILTER (WHERE u.decision = 'aceptado') AS aceptados, "
        " count(*) FILTER (WHERE u.decision = 'rechazado') AS rechazados, "
        " count(h.id) FILTER (WHERE u.decision IS NULL) AS pendientes "
        "FROM candidato c JOIN corrida co ON co.id = c.corrida_id "
        f"LEFT JOIN hallazgo h ON h.corrida_id = c.corrida_id {_ULTIMA_DECISION} "
        "WHERE c.estado = 'abierto' GROUP BY c.id, co.id ORDER BY c.creado_en, c.id",
    )


def corridas_fallidas(conn: psycopg.Connection) -> list[Fila]:
    """Corridas que fallaron y siguen sin resolverse: ninguna posterior de la fuente terminó bien."""
    return _filas(
        conn,
        "SELECT c.id, c.fuente_id, c.iniciada_en, c.terminada_en, c.error FROM corrida c "
        "WHERE c.estado = 'fallida' AND NOT EXISTS (SELECT 1 FROM corrida c2 WHERE c2.fuente_id = c.fuente_id "
        " AND c2.id > c.id AND c2.estado IN ('sin_cambios', 'con_candidato')) ORDER BY c.id DESC",
    )


def historial(conn: psycopg.Connection, limite: int = 50) -> list[Fila]:
    """Candidatos ya decididos (publicados o descartados), del más reciente al más viejo."""
    return _filas(
        conn,
        "SELECT c.id, c.estado, c.decidido_en, c.decidido_por, c.motivo, c.corrida_id, co.fuente_id, r.release_id, "
        " (SELECT count(*) FROM hallazgo h WHERE h.corrida_id = c.corrida_id) AS hallazgos "
        "FROM candidato c JOIN corrida co ON co.id = c.corrida_id LEFT JOIN release r ON r.candidato_id = c.id "
        "WHERE c.estado IN ('publicado', 'descartado') ORDER BY c.decidido_en DESC, c.id DESC LIMIT %s",
        (limite,),
    )


def candidato(conn: psycopg.Connection, candidato_id: int) -> Fila | None:
    return _fila(
        conn,
        "SELECT c.id, c.estado, c.creado_en, c.decidido_en, c.decidido_por, c.motivo, c.corrida_id, co.fuente_id, "
        " f.nombre AS fuente_nombre, co.resumen, r.numero AS release_numero, r.release_id, r.publicado_en, r.aprobado_por "
        "FROM candidato c JOIN corrida co ON co.id = c.corrida_id JOIN fuente f ON f.id = co.fuente_id "
        "LEFT JOIN release r ON r.candidato_id = c.id WHERE c.id = %s",
        (candidato_id,),
    )


def archivos_de_corrida(conn: psycopg.Connection, corrida_id: int) -> list[Fila]:
    return _filas(
        conn,
        "SELECT d.url, d.sha256, d.estado, d.descargada_en, d.publicada_en, d.error, d.bytes "
        "FROM corrida_descarga cd JOIN descarga d ON d.id = cd.descarga_id WHERE cd.corrida_id = %s ORDER BY d.id",
        (corrida_id,),
    )


def corrida(conn: psycopg.Connection, corrida_id: int) -> Fila | None:
    return _fila(
        conn,
        "SELECT c.id, c.fuente_id, c.estado, c.iniciada_en, c.terminada_en, c.error, c.resumen, "
        " (SELECT id FROM candidato WHERE corrida_id = c.id) AS candidato_id FROM corrida c WHERE c.id = %s",
        (corrida_id,),
    )


def hallazgos(conn: psycopg.Connection, candidato_id: int) -> list[Fila]:
    """Los hallazgos del candidato con su decisión vigente, quién la tomó y sus propuestas."""
    filas = _filas(
        conn,
        "SELECT h.id, h.regla, h.severidad, h.serie_id, s.nombre AS serie_nombre, h.periodo, h.detalle, "
        " u.decision, u.revisor, u.comentario, u.decidida_en, "
        " (SELECT count(*) FROM revision_hallazgo r WHERE r.hallazgo_id = h.id) AS revisiones "
        "FROM candidato c JOIN hallazgo h ON h.corrida_id = c.corrida_id LEFT JOIN serie s ON s.id = h.serie_id "
        "LEFT JOIN LATERAL (SELECT decision, revisor, comentario, decidida_en FROM revision_hallazgo r "
        " WHERE r.hallazgo_id = h.id ORDER BY r.id DESC LIMIT 1) u ON true WHERE c.id = %s "
        "ORDER BY h.id",
        (candidato_id,),
    )
    propuestas = _filas(
        conn,
        "SELECT p.hallazgo_id, p.tipo, p.valor_actual, p.valor_propuesto, p.evidencia, p.confianza, p.estado "
        "FROM propuesta p JOIN hallazgo h ON h.id = p.hallazgo_id JOIN candidato c ON c.corrida_id = h.corrida_id "
        "WHERE c.id = %s ORDER BY p.id",
        (candidato_id,),
    )
    por_hallazgo: dict[int, list[Fila]] = {}
    for propuesta in propuestas:
        por_hallazgo.setdefault(propuesta["hallazgo_id"], []).append(propuesta)
    for fila in filas:
        fila["propuestas"] = por_hallazgo.get(fila["id"], [])
    return filas


def diferencias(conn: psycopg.Connection, candidato_id: int, limite: int = 40) -> Fila:
    """Qué cambia el candidato respecto de lo vigente hoy: períodos nuevos, con otro valor o que faltan."""
    fuente_id = conn.execute(
        "SELECT co.fuente_id FROM candidato c JOIN corrida co ON co.id = c.corrida_id WHERE c.id = %s", (candidato_id,)
    ).fetchone()[0]
    filas = _filas(
        conn,
        "SELECT c.serie_id, c.periodo, c.valor AS nuevo, v.valor AS vigente, "
        " CASE WHEN v.valor IS NULL THEN 'nuevo' ELSE 'cambiado' END AS tipo "
        "FROM observacion_candidata c LEFT JOIN observacion_vigente v ON v.serie_id = c.serie_id AND v.periodo = c.periodo "
        "WHERE c.candidato_id = %(c)s AND (v.valor IS NULL OR v.valor <> c.valor) "
        "UNION ALL "
        "SELECT v.serie_id, v.periodo, NULL, v.valor, 'faltante' FROM observacion_vigente v JOIN serie s ON s.id = v.serie_id "
        "WHERE s.fuente_id = %(f)s AND NOT EXISTS (SELECT 1 FROM observacion_candidata c WHERE c.candidato_id = %(c)s "
        " AND c.serie_id = v.serie_id AND c.periodo = v.periodo) "
        "ORDER BY 5, 1, 2",
        {"c": candidato_id, "f": fuente_id},
    )
    cuenta = {tipo: sum(1 for f in filas if f["tipo"] == tipo) for tipo in ("nuevo", "cambiado", "faltante")}
    # Lo que cambia o falta importa más que lo nuevo: va primero cuando hay que recortar.
    relevantes = sorted(filas, key=lambda f: (f["tipo"] == "nuevo", f["serie_id"], f["periodo"]))
    return {"nuevos": cuenta["nuevo"], "cambiados": cuenta["cambiado"], "faltantes": cuenta["faltante"], "filas": relevantes[:limite], "total": len(filas)}


def series_para_graficos(conn: psycopg.Connection, candidato_id: int, serie_ids: Sequence[str]) -> dict[str, dict[str, list[tuple[date, Decimal]]]]:
    """Para cada serie, el candidato y lo vigente hoy: lo que dibuja el gráfico de un hallazgo."""
    resultado: dict[str, dict[str, list[tuple[date, Decimal]]]] = {s: {"candidato": [], "vigente": []} for s in serie_ids}
    if not serie_ids:
        return resultado
    for serie_id, periodo, valor in conn.execute(
        "SELECT serie_id, periodo, valor FROM observacion_candidata WHERE candidato_id = %s AND serie_id = ANY(%s) ORDER BY serie_id, periodo",
        (candidato_id, list(serie_ids)),
    ):
        resultado[serie_id]["candidato"].append((periodo, valor))
    for serie_id, periodo, valor in conn.execute(
        "SELECT serie_id, periodo, valor FROM observacion_vigente WHERE serie_id = ANY(%s) ORDER BY serie_id, periodo", (list(serie_ids),)
    ):
        resultado[serie_id]["vigente"].append((periodo, valor))
    return resultado


def hallazgo_pertenece(conn: psycopg.Connection, candidato_id: int, hallazgo_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM hallazgo h JOIN candidato c ON c.corrida_id = h.corrida_id WHERE c.id = %s AND h.id = %s",
        (candidato_id, hallazgo_id),
    ).fetchone() is not None


def hallazgos_pendientes(conn: psycopg.Connection, candidato_id: int, regla: str | None = None) -> list[int]:
    """Ids de los hallazgos sin ninguna decisión, opcionalmente solo de una regla."""
    return [
        f[0]
        for f in conn.execute(
            "SELECT h.id FROM candidato c JOIN hallazgo h ON h.corrida_id = c.corrida_id "
            f"{_ULTIMA_DECISION} WHERE c.id = %s AND u.decision IS NULL AND (%s::text IS NULL OR h.regla = %s) ORDER BY h.id",
            (candidato_id, regla, regla),
        )
    ]
