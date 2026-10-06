"""Revisión y publicación de un candidato: lo que pasa después de que una persona lo mira.

Publicar convierte el contenido de un candidato abierto en el release vigente. Es la
única forma de que un dato llegue a la capa publicada, y por eso exige que cada
hallazgo del candidato haya sido aceptado por alguien. Todo ocurre en una transacción:
o queda el release completo, o no queda nada.

El release es una foto completa de la fuente: lo publicado después de publicar es
exactamente el candidato. Los períodos que cambian se cierran y se abren de nuevo; los
que ya no están en el candidato se cierran; los que no cambian no se tocan.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Iterable

import psycopg
from psycopg import errors
from psycopg.types.json import Jsonb

from servicio_datos.ipc import fuente


class ErrorPublicacion(Exception):
    """No se pudo revisar o publicar. `codigo` dice por qué, para que la interfaz reaccione."""

    def __init__(self, codigo: str, mensaje: str):
        super().__init__(mensaje)
        self.codigo = codigo


@dataclass(frozen=True)
class EstadoRevision:
    total: int
    aceptados: int
    rechazados: int
    pendientes: int  # sin ninguna decisión
    propuestas_pendientes: int  # propuestas del agente sin decidir


@dataclass(frozen=True)
class Publicacion:
    release_numero: int
    release_id: str
    hash_contenido: str
    observaciones_abiertas: int  # versiones nuevas (períodos nuevos o con otro valor)
    observaciones_cerradas: int  # versiones que dejan de estar vigentes
    observaciones_sin_cambio: int


def hash_contenido(filas: Iterable[tuple[str, date, Decimal]]) -> str:
    """SHA-256 del contenido de un release: serie, período y valor, en orden.

    El valor se normaliza (100, 100.0 y 100.000 dan lo mismo), así que depende del dato y
    no de cómo lo escribió quien lo cargó.
    """
    lineas = sorted(f"{serie_id}|{periodo.isoformat()}|{format(valor.normalize(), 'f')}" for serie_id, periodo, valor in filas)
    return hashlib.sha256("\n".join(lineas).encode("utf-8")).hexdigest()


def revisar_hallazgo(
    conn: psycopg.Connection, hallazgo_id: int, decision: str, revisor: str, comentario: str | None = None
) -> None:
    """Registra una decisión sobre un hallazgo. Una decisión nueva reemplaza a la anterior."""
    try:
        conn.execute(
            "INSERT INTO revision_hallazgo (hallazgo_id, decision, revisor, comentario) VALUES (%s, %s, %s, %s)",
            (hallazgo_id, decision, revisor, comentario),
        )
    except errors.RaiseException as error:
        raise ErrorPublicacion("candidato_cerrado", "Ese hallazgo ya no se puede revisar: su candidato no está abierto") from error
    except (errors.CheckViolation, errors.ForeignKeyViolation) as error:
        raise ErrorPublicacion("revision_invalida", f"Revisión inválida: {error.diag.message_primary}") from error


def estado_revision(conn: psycopg.Connection, candidato_id: int) -> EstadoRevision:
    fila = conn.execute("SELECT corrida_id FROM candidato WHERE id = %s", (candidato_id,)).fetchone()
    if fila is None:
        raise ErrorPublicacion("no_existe", f"No existe el candidato {candidato_id}")
    corrida_id = fila[0]
    hallazgos = conn.execute(
        "WITH ultima AS ("
        " SELECT DISTINCT ON (r.hallazgo_id) r.hallazgo_id, r.decision FROM revision_hallazgo r"
        " JOIN hallazgo h ON h.id = r.hallazgo_id WHERE h.corrida_id = %(c)s ORDER BY r.hallazgo_id, r.id DESC)"
        " SELECT count(*), count(*) FILTER (WHERE u.decision = 'aceptado'),"
        "  count(*) FILTER (WHERE u.decision = 'rechazado'), count(*) FILTER (WHERE u.decision IS NULL)"
        " FROM hallazgo h LEFT JOIN ultima u ON u.hallazgo_id = h.id WHERE h.corrida_id = %(c)s",
        {"c": corrida_id},
    ).fetchone()
    propuestas = conn.execute(
        "SELECT count(*) FROM propuesta p JOIN hallazgo h ON h.id = p.hallazgo_id "
        "WHERE h.corrida_id = %s AND p.estado = 'pendiente'", (corrida_id,),
    ).fetchone()[0]
    return EstadoRevision(*hallazgos, propuestas)


def _utc(momento: datetime | None) -> str | None:
    return momento.astimezone(timezone.utc).isoformat() if momento else None


def procedencia_de(conn: psycopg.Connection, corrida_id: int) -> dict:
    """Qué archivos y qué hoja, fila y notas respaldan a cada serie de una corrida.

    La captura es la primera vez que se vio el archivo (no cuando se lo volvió a ver idéntico),
    y la publicación es la fecha que informa la fuente.
    """
    resumen = conn.execute("SELECT resumen FROM corrida WHERE id = %s", (corrida_id,)).fetchone()[0]
    archivos = []
    for archivo in resumen.get("archivos", []):
        captura, publicada = conn.execute(
            "SELECT min(descargada_en), max(publicada_en) FROM descarga "
            "WHERE url = %s AND sha256 = %s AND estado IN ('nueva', 'identica')",
            (archivo["url"], archivo["sha256"]),
        ).fetchone()
        archivos.append({
            "clave": archivo["clave"], "file": archivo["url"].rsplit("/", 1)[-1], "url": archivo["url"],
            "sha256": archivo["sha256"], "retrieved_at": _utc(captura), "published_at": _utc(publicada),
        })
    return {"archivos": archivos, "series": resumen.get("detalle_series", {})}


def _plural(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def publicar_candidato(
    conn: psycopg.Connection, candidato_id: int, aprobado_por: str, *,
    fecha: date | None = None, prefijo: str = fuente.RELEASE_PREFIJO,
) -> Publicacion:
    if not aprobado_por or not aprobado_por.strip():
        raise ErrorPublicacion("aprobador_vacio", "Falta quién aprueba la publicación")
    fecha = fecha or datetime.now(timezone.utc).date()

    with conn.transaction():
        previo = conn.execute(
            "SELECT co.fuente_id, c.corrida_id FROM candidato c JOIN corrida co ON co.id = c.corrida_id WHERE c.id = %s",
            (candidato_id,),
        ).fetchone()
        if previo is None:
            raise ErrorPublicacion("no_existe", f"No existe el candidato {candidato_id}")
        # Una publicación por vez por fuente: dos releases a la vez se pisarían las versiones.
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", ("publicar:" + previo[0],))
        estado = conn.execute("SELECT estado FROM candidato WHERE id = %s FOR UPDATE", (candidato_id,)).fetchone()[0]
        if estado != "abierto":
            raise ErrorPublicacion("no_abierto", f"El candidato {candidato_id} no está abierto (estado: {estado})")

        revision = estado_revision(conn, candidato_id)
        if revision.rechazados:
            raise ErrorPublicacion(
                "hallazgos_rechazados",
                f"Hay {_plural(revision.rechazados, 'hallazgo rechazado', 'hallazgos rechazados')}: "
                "el candidato no se publica, hay que descartarlo o esperar uno nuevo",
            )
        if revision.pendientes:
            raise ErrorPublicacion(
                "hallazgos_pendientes", f"Faltan {_plural(revision.pendientes, 'hallazgo', 'hallazgos')} por resolver"
            )
        if revision.propuestas_pendientes:
            raise ErrorPublicacion(
                "propuestas_pendientes",
                f"Faltan decidir {_plural(revision.propuestas_pendientes, 'propuesta', 'propuestas')} del agente",
            )

        filas = conn.execute(
            "SELECT serie_id, periodo, valor FROM observacion_candidata WHERE candidato_id = %s ORDER BY serie_id, periodo",
            (candidato_id,),
        ).fetchall()
        if not filas:
            raise ErrorPublicacion("candidato_vacio", f"El candidato {candidato_id} no tiene observaciones")

        contenido = hash_contenido(filas)
        release_id, intento = f"{prefijo}-{fecha.isoformat()}-{contenido[:10]}", 1
        while conn.execute("SELECT 1 FROM release WHERE release_id = %s", (release_id,)).fetchone():
            # El mismo contenido el mismo día (un cambio y su vuelta atrás): se distingue con un número.
            intento += 1
            release_id = f"{prefijo}-{fecha.isoformat()}-{contenido[:10]}-{intento}"
        numero = conn.execute(
            "INSERT INTO release (release_id, candidato_id, aprobado_por, hash_contenido, procedencia) "
            "VALUES (%s, %s, %s, %s, %s) RETURNING numero",
            (release_id, candidato_id, aprobado_por.strip(), contenido, Jsonb(procedencia_de(conn, previo[1]))),
        ).fetchone()[0]

        # Se cierra lo que ya no coincide con el candidato y después se abre lo que no está vigente.
        cerradas = conn.execute(
            "UPDATE observacion o SET release_hasta = %s FROM serie s "
            "WHERE s.id = o.serie_id AND s.fuente_id = %s AND o.release_hasta IS NULL AND NOT EXISTS ("
            " SELECT 1 FROM observacion_candidata c WHERE c.candidato_id = %s AND c.serie_id = o.serie_id "
            " AND c.periodo = o.periodo AND c.valor = o.valor)",
            (numero, previo[0], candidato_id),
        ).rowcount
        abiertas = conn.execute(
            "INSERT INTO observacion (serie_id, periodo, valor, release_desde) "
            "SELECT c.serie_id, c.periodo, c.valor, %s FROM observacion_candidata c WHERE c.candidato_id = %s "
            "AND NOT EXISTS (SELECT 1 FROM observacion o WHERE o.serie_id = c.serie_id AND o.periodo = c.periodo "
            " AND o.valor = c.valor AND o.release_hasta IS NULL)",
            (numero, candidato_id),
        ).rowcount
        conn.execute(
            "UPDATE candidato SET estado = 'publicado', decidido_en = now(), decidido_por = %s WHERE id = %s",
            (aprobado_por.strip(), candidato_id),
        )
    return Publicacion(numero, release_id, contenido, abiertas, cerradas, len(filas) - abiertas)


def descartar_candidato(conn: psycopg.Connection, candidato_id: int, decidido_por: str, motivo: str) -> None:
    """Rechaza el candidato entero. No toca nada de lo publicado."""
    if not decidido_por.strip() or not motivo.strip():
        raise ErrorPublicacion("descarte_incompleto", "Descartar un candidato exige quién lo descarta y por qué")
    actualizado = conn.execute(
        "UPDATE candidato SET estado = 'descartado', decidido_en = now(), decidido_por = %s, motivo = %s "
        "WHERE id = %s AND estado = 'abierto' RETURNING id",
        (decidido_por.strip(), motivo.strip(), candidato_id),
    ).fetchone()
    if actualizado is None:
        existe = conn.execute("SELECT estado FROM candidato WHERE id = %s", (candidato_id,)).fetchone()
        if existe is None:
            raise ErrorPublicacion("no_existe", f"No existe el candidato {candidato_id}")
        raise ErrorPublicacion("no_abierto", f"El candidato {candidato_id} no está abierto (estado: {existe[0]})")
