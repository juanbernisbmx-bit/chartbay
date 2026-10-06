"""Colector del IPC: baja los archivos de INDEC, los guarda y registra qué pasó.

No interpreta los datos: eso es del parser. Acá solo se decide si hay algo nuevo.
Una corrida termina `sin_cambios` (todo idéntico a lo ya conocido), `fallida`, o
queda `en_curso` con datos nuevos para que la etapa siguiente la cierre.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime

import psycopg

from servicio_datos import repositorio
from servicio_datos.cliente_http import ClienteHttp, ErrorHttp
from servicio_datos.crudo import AlmacenCrudo
from servicio_datos.ipc import fuente
from servicio_datos.ipc.modelos import DescargaRegistrada

VENCIMIENTO_SEGUNDOS = 6 * 3600
MAGIA_XLS = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # contenedor OLE2 de los .xls
MIN_BYTES_XLS = 10_000


class ErrorColecta(Exception):
    def __init__(self, url: str, mensaje: str):
        super().__init__(mensaje)
        self.url = url


@dataclass(frozen=True)
class ResultadoColecta:
    corrida_id: int | None
    estado: str  # 'sin_cambios' | 'nuevos_datos' | 'fallida' | 'ocupado'
    descargas: tuple[DescargaRegistrada, ...]
    error: str | None = None


def es_xls(contenido: bytes) -> bool:
    return len(contenido) >= MIN_BYTES_XLS and contenido.startswith(MAGIA_XLS)


def _buscar(cliente: ClienteHttp, archivo: fuente.ArchivoFuente) -> tuple[str, bytes, datetime | None]:
    """Primer candidato que sea de verdad un .xls, del más nuevo al más viejo.

    INDEC contesta 200 con una página HTML a los archivos que todavía no existen,
    así que el criterio es el contenido. Un error de red NO pasa al candidato
    siguiente: caer al mes anterior ocultaría que hay una publicación nueva.
    """
    url = ""
    for url in archivo.urls_candidatas():
        try:
            respuesta = cliente.get(url)
        except ErrorHttp as error:
            raise ErrorColecta(url, str(error)) from error
        if respuesta.estado == 200 and es_xls(respuesta.contenido):
            return url, respuesta.contenido, respuesta.last_modified
    raise ErrorColecta(url, f"Ninguna de {len(archivo.nombres)} URL candidata de «{archivo.clave}» devolvió un archivo XLS")


def colectar(
    conn: psycopg.Connection,
    almacen: AlmacenCrudo,
    cliente: ClienteHttp,
    hoy: date,
    vencimiento_segundos: float = VENCIMIENTO_SEGUNDOS,
) -> ResultadoColecta:
    repositorio.asegurar_fuente(conn, fuente.FUENTE_ID, fuente.FUENTE_NOMBRE, fuente.URL_PUBLICACION)
    corrida = repositorio.abrir_corrida_exclusiva(conn, fuente.FUENTE_ID, vencimiento_segundos)
    if corrida is None:
        return ResultadoColecta(None, "ocupado", (), "Ya hay una corrida en curso para esta fuente")

    registradas: list[DescargaRegistrada] = []
    try:
        for archivo in fuente.archivos(hoy):
            url, contenido, publicada_en = _buscar(cliente, archivo)
            sha256, relativa = almacen.guardar(contenido)
            previa = repositorio.ultima_conocida(conn, url)
            estado = "identica" if previa and previa.sha256 == sha256 else "nueva"
            descarga_id = repositorio.registrar_descarga(
                conn, corrida, fuente.FUENTE_ID, url, estado,
                sha256=sha256, bytes=len(contenido), ruta_crudo=relativa, publicada_en=publicada_en,
            )
            registradas.append(
                DescargaRegistrada(descarga_id, archivo.clave, url, sha256, almacen.ruta(relativa), estado, publicada_en)
            )
    except ErrorColecta as error:
        repositorio.registrar_descarga(conn, corrida, fuente.FUENTE_ID, error.url, "fallida", error=str(error))
        repositorio.cerrar_corrida(conn, corrida, "fallida", error=str(error), resumen=_resumen(registradas))
        return ResultadoColecta(corrida, "fallida", tuple(registradas), str(error))
    except BaseException as error:
        # Un fallo inesperado no puede dejar la corrida en curso: bloquearía la fuente.
        repositorio.cerrar_corrida(conn, corrida, "fallida", error=f"{type(error).__name__}: {error}")
        raise

    resumen = _resumen(registradas)
    if all(d.estado == "identica" for d in registradas):
        repositorio.cerrar_corrida(conn, corrida, "sin_cambios", resumen=resumen)
        return ResultadoColecta(corrida, "sin_cambios", tuple(registradas))
    repositorio.guardar_resumen(conn, corrida, resumen)
    return ResultadoColecta(corrida, "nuevos_datos", tuple(registradas))


def _resumen(descargas: list[DescargaRegistrada]) -> dict:
    return {
        "archivos": [
            {"clave": d.clave, "url": d.url, "estado": d.estado, "sha256": d.sha256,
             "publicada_en": d.publicada_en.isoformat() if d.publicada_en else None}
            for d in descargas
        ]
    }
