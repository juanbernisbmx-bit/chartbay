"""Corrida completa del IPC: colecta, parseo, validación y candidato.

Une las tres etapas y es quien cierra la corrida. Termina en uno de cuatro estados:

- `sin_cambios`: no hay nada nuevo (los archivos son idénticos, o son nuevos pero
  traen exactamente los datos ya publicados).
- `con_candidato`: hay un candidato abierto esperando revisión.
- `fallida`: algo se rompió y hay que mirar. Nunca queda un candidato a medias.
- `ocupado`: ya había otra corrida en curso.

El parser y la validación entran por parámetro: así se prueba el orquestador sin
los archivos de INDEC, y los reales (ipc/parser.py, ipc/validacion.py) se usan
cuando no se pasa nada.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Callable, Mapping, Sequence

import psycopg

from servicio_datos import colector, repositorio
from servicio_datos.cliente_http import ClienteHttp
from servicio_datos.crudo import AlmacenCrudo
from servicio_datos.ipc import fuente
from servicio_datos.ipc.modelos import DescargaRegistrada, Hallazgo, SerieLeida

LeerArchivo = Callable[..., Mapping[str, SerieLeida]]
Validar = Callable[..., list[Hallazgo]]


@dataclass(frozen=True)
class ResultadoCorrida:
    corrida_id: int | None
    estado: str  # 'sin_cambios' | 'con_candidato' | 'fallida' | 'ocupado'
    candidato_id: int | None = None
    hallazgos: tuple[Hallazgo, ...] = ()
    error: str | None = None


def _dependencias(leer_archivo: LeerArchivo | None, validar: Validar | None) -> tuple[LeerArchivo, Validar]:
    if leer_archivo is None or validar is None:
        try:
            from servicio_datos.ipc import parser, validacion
        except ImportError as error:
            raise RuntimeError(
                "El parser y la validación del IPC no están disponibles (servicio_datos/ipc/parser.py "
                f"y validacion.py, y la dependencia xlrd): {error}"
            ) from error
        leer_archivo, validar = leer_archivo or parser.leer_archivo, validar or validacion.validar
    return leer_archivo, validar


def _leer_series(
    descargas: Sequence[DescargaRegistrada], hoy: date, leer_archivo: LeerArchivo
) -> dict[str, SerieLeida]:
    archivos = {a.clave: a for a in fuente.archivos(hoy)}
    series: dict[str, SerieLeida] = {}
    for descarga in descargas:
        for serie_id, serie in leer_archivo(descarga.ruta, archivos[descarga.clave]).items():
            if serie_id in series:
                raise ValueError(f"La serie {serie_id} aparece en más de un archivo de la corrida")
            series[serie_id] = serie
    return series


def _diferencias(series: Mapping[str, SerieLeida], vigentes: Mapping[str, Mapping[date, Decimal]]) -> dict[str, int]:
    """Cuánto cambia el candidato respecto de lo publicado, en períodos."""
    nuevos = cambiados = faltantes = 0
    for serie_id, serie in series.items():
        publicadas = vigentes.get(serie_id, {})
        propuestas = dict(serie.observaciones)
        nuevos += sum(1 for periodo in propuestas if periodo not in publicadas)
        cambiados += sum(1 for periodo, valor in propuestas.items() if periodo in publicadas and publicadas[periodo] != valor)
        faltantes += sum(1 for periodo in publicadas if periodo not in propuestas)
    faltantes += sum(len(publicadas) for serie_id, publicadas in vigentes.items() if serie_id not in series)
    return {"periodos_nuevos": nuevos, "periodos_cambiados": cambiados, "periodos_faltantes": faltantes}


def _conteo(hallazgos: Sequence[Hallazgo]) -> dict[str, int]:
    return {severidad: sum(1 for h in hallazgos if h.severidad == severidad) for severidad in ("alta", "media", "baja")}


def correr_ipc(
    conn: psycopg.Connection,
    almacen: AlmacenCrudo,
    cliente: ClienteHttp,
    hoy: date,
    *,
    leer_archivo: LeerArchivo | None = None,
    validar: Validar | None = None,
    vencimiento_segundos: float = colector.VENCIMIENTO_SEGUNDOS,
) -> ResultadoCorrida:
    leer_archivo, validar = _dependencias(leer_archivo, validar)

    colecta = colector.colectar(conn, almacen, cliente, hoy, vencimiento_segundos)
    if colecta.estado == "ocupado":
        return ResultadoCorrida(None, "ocupado", error=colecta.error)
    if colecta.estado == "fallida":
        return ResultadoCorrida(colecta.corrida_id, "fallida", error=colecta.error)
    if colecta.estado == "sin_cambios":
        return ResultadoCorrida(colecta.corrida_id, "sin_cambios")

    corrida = colecta.corrida_id
    try:
        series = _leer_series(colecta.descargas, hoy, leer_archivo)
        vigentes = repositorio.vigentes(conn, fuente.FUENTE_ID)
        hallazgos = validar(series, vigentes, colecta.descargas, hoy=hoy)
        diferencias = _diferencias(series, vigentes)

        # Un archivo nuevo con exactamente los datos ya publicados no es una novedad.
        if vigentes and not any(diferencias.values()):
            repositorio.cerrar_corrida(
                conn, corrida, "sin_cambios",
                resumen={**diferencias, "motivo": "Archivos nuevos con los mismos datos que el release vigente"},
            )
            return ResultadoCorrida(corrida, "sin_cambios")

        # Lo que ya se revisó al publicar no vuelve a la cola: si no, el mismo aviso
        # histórico reaparecería en cada mes.
        revisados = repositorio.hallazgos_revisados(conn, fuente.FUENTE_ID)
        nuevos = [h for h in hallazgos if (h.regla, h.serie_id, h.periodo, h.detalle) not in revisados]

        with conn.transaction():
            origenes = {s.serie_id: (s.hoja, s.fila_origen) for s in series.values()}
            existentes = repositorio.asegurar_series(conn, fuente.FUENTE_ID, fuente.SERIES, origenes)
            reemplazados = repositorio.descartar_candidatos_abiertos(
                conn, fuente.FUENTE_ID, f"Reemplazado por el candidato de la corrida {corrida}")
            candidato = repositorio.crear_candidato(conn, corrida)
            repositorio.guardar_observaciones_candidatas(
                conn, candidato,
                [(s.serie_id, periodo, valor) for s in series.values() for periodo, valor in s.observaciones],
            )
            # Un hallazgo sobre una serie que la base no conoce se guarda sin serie; el texto la nombra.
            repositorio.guardar_hallazgos(
                conn, corrida,
                [(h.serie_id if h.serie_id in existentes else None, h.periodo, h.regla, h.severidad, h.detalle) for h in nuevos],
            )
            repositorio.cerrar_corrida(conn, corrida, "con_candidato", resumen={
                "candidato_id": candidato,
                "series": len(series),
                "observaciones": sum(len(s.observaciones) for s in series.values()),
                **diferencias,
                "hallazgos": _conteo(nuevos),
                "hallazgos_ya_revisados": len(hallazgos) - len(nuevos),
                "reemplaza_candidatos": reemplazados,
            })
        return ResultadoCorrida(corrida, "con_candidato", candidato, tuple(nuevos))
    except ValueError as error:
        # El parser rechaza lo que no puede interpretar: es un problema de los datos, no un bug.
        mensaje = f"No se pudo leer lo descargado: {error}"
        repositorio.cerrar_corrida(conn, corrida, "fallida", error=mensaje)
        return ResultadoCorrida(corrida, "fallida", error=mensaje)
    except BaseException as error:
        repositorio.cerrar_corrida(conn, corrida, "fallida", error=f"{type(error).__name__}: {error}")
        raise
