"""Revisión y publicación de un candidato: lo que pasa después de que una persona lo mira.

La lógica vive en funciones de la base (migración 0010), para que la puedan usar también una Edge Function o la página de
revisión de ChartBay. Este módulo es la puerta de entrada desde Python: llama a esas funciones y traduce sus errores.

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
from datetime import date
from decimal import Decimal
from typing import Iterable

import psycopg

from servicio_datos.ipc import fuente


ERROR_DE_NEGOCIO = "CB001"  # el SQLSTATE con que fallan las funciones de la base; el DETAIL trae el código


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


def _llamar(conn: psycopg.Connection, consulta: str, parametros: tuple = ()) -> psycopg.Cursor:
    """Llama a una función de la base, en su propia transacción (o en la de quien llama), y traduce sus errores."""
    try:
        with conn.transaction():
            return conn.execute(consulta, parametros)
    except psycopg.Error as error:
        if error.sqlstate == ERROR_DE_NEGOCIO:
            raise ErrorPublicacion(error.diag.message_detail or "error", error.diag.message_primary or str(error)) from None
        raise


def revisar_hallazgo(
    conn: psycopg.Connection, hallazgo_id: int, decision: str, revisor: str, comentario: str | None = None
) -> None:
    """Registra una decisión sobre un hallazgo. Una decisión nueva reemplaza a la anterior.

    También resuelve las propuestas del agente que seguían pendientes sobre ese hallazgo: aprobada si la persona decidió lo
    que sugería, rechazada si no (ver `resolver_propuestas` en la migración 0010).
    """
    _llamar(conn, "SELECT revisar_hallazgo(%s, %s, %s, %s)", (hallazgo_id, decision, revisor, comentario))


def aceptar_pendientes(conn: psycopg.Connection, candidato_id: int, revisor: str, comentario: str | None = None,
                       regla: str | None = None) -> int:
    """Acepta de una vez los hallazgos sin decisión (los de una regla, o todos). Todos o ninguno. Devuelve cuántos."""
    return _llamar(conn, "SELECT aceptar_pendientes(%s, %s, %s, %s)", (candidato_id, revisor, comentario, regla)).fetchone()[0]


def estado_revision(conn: psycopg.Connection, candidato_id: int) -> EstadoRevision:
    return EstadoRevision(*_llamar(conn, "SELECT * FROM estado_revision(%s)", (candidato_id,)).fetchone())


def procedencia_de(conn: psycopg.Connection, corrida_id: int) -> dict:
    """Qué archivos y qué hoja, fila y notas respaldan a cada serie de una corrida (ver `procedencia_de` en la base)."""
    return _llamar(conn, "SELECT procedencia_de(%s)", (corrida_id,)).fetchone()[0]


def publicar_candidato(
    conn: psycopg.Connection, candidato_id: int, aprobado_por: str, *,
    fecha: date | None = None, prefijo: str = fuente.RELEASE_PREFIJO,
) -> Publicacion:
    fila = _llamar(conn, "SELECT * FROM publicar_candidato(%s, %s, %s, %s)", (candidato_id, aprobado_por, prefijo, fecha)).fetchone()
    return Publicacion(*fila)


def descartar_candidato(conn: psycopg.Connection, candidato_id: int, decidido_por: str, motivo: str) -> None:
    """Rechaza el candidato entero. No toca nada de lo publicado."""
    _llamar(conn, "SELECT descartar_candidato(%s, %s, %s)", (candidato_id, decidido_por, motivo))
