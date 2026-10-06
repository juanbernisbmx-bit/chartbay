"""Lectura estricta de los cuadros XLS del IPC de INDEC."""
from __future__ import annotations

import math
from datetime import date
from decimal import Decimal
from pathlib import Path

import xlrd

from servicio_datos.ipc.fuente import ArchivoFuente
from servicio_datos.ipc.modelos import SerieLeida

BASE = date(2016, 12, 1)
VALOR_BASE = Decimal("100")
MAX_FILAS_HASTA_NIVEL = 7


class ErrorParseo(ValueError):
    """El archivo no cumple el contrato estructural de la fuente."""


def _mes(fecha: date) -> int:
    return fecha.year * 12 + fecha.month


def leer_archivo(ruta: Path, archivo: ArchivoFuente) -> dict[str, SerieLeida]:
    """Extrae las series configuradas sin inventar períodos ni valores.

    El día del encabezado se normaliza al primer día del mes y se registra en
    `notas` cuando difiere. Una forma o un valor no interpretable aborta la carga.
    """
    try:
        libro = xlrd.open_workbook(str(ruta))
        hoja = libro.sheet_by_name(archivo.hoja)
    except (OSError, xlrd.XLRDError) as error:
        raise ErrorParseo(f"No se pudo abrir la hoja «{archivo.hoja}» de {Path(ruta).name}: {error}") from error

    resultado: dict[str, SerieLeida] = {}
    for fila in range(hoja.nrows):
        rotulo = str(hoja.cell_value(fila, 0)).strip()
        if rotulo not in archivo.series:
            continue
        serie_id = archivo.series[rotulo]
        if serie_id in resultado:
            raise ErrorParseo(f"Rótulo repetido para {serie_id} en {archivo.hoja}")
        candidatas = [indice for indice in range(fila + 1, min(fila + MAX_FILAS_HASTA_NIVEL + 1, hoja.nrows))
                      if str(hoja.cell_value(indice, 0)).strip() == "Nivel general"]
        if len(candidatas) != 1:
            raise ErrorParseo(f"Se esperaba una fila Nivel general para {rotulo}; encontradas: {len(candidatas)}")
        fila_valores = candidatas[0]
        observaciones: list[tuple[date, Decimal]] = []
        notas: list[str] = []
        for columna in range(1, hoja.ncols):
            encabezado = hoja.cell(fila, columna)
            if encabezado.ctype == xlrd.XL_CELL_EMPTY:
                continue
            if encabezado.ctype != xlrd.XL_CELL_DATE:
                raise ErrorParseo(f"Encabezado temporal inesperado en {serie_id}, columna {columna + 1}")
            try:
                fecha_original = xlrd.xldate_as_datetime(encabezado.value, libro.datemode).date()
            except (ValueError, OverflowError) as error:
                raise ErrorParseo(f"Fecha Excel inválida en {serie_id}, columna {columna + 1}") from error
            periodo = fecha_original.replace(day=1)
            if fecha_original.day != 1:
                notas.append(f"Encabezado {fecha_original:%Y-%m-%d} interpretado como período mensual {periodo:%Y-%m}")
            celda = hoja.cell(fila_valores, columna)
            if celda.ctype != xlrd.XL_CELL_NUMBER or not math.isfinite(celda.value) or celda.value <= 0:
                raise ErrorParseo(f"Valor no numérico o no positivo en {serie_id}, {periodo:%Y-%m}")
            observaciones.append((periodo, Decimal(str(celda.value))))

        if not observaciones:
            raise ErrorParseo(f"La serie {serie_id} no contiene observaciones")
        if observaciones[0] != (BASE, VALOR_BASE):
            raise ErrorParseo(f"La base de referencia de {serie_id} cambió: se espera diciembre de 2016 = 100")
        for anterior, actual in zip(observaciones, observaciones[1:]):
            if _mes(actual[0]) - _mes(anterior[0]) != 1:
                raise ErrorParseo(f"Períodos repetidos, ausentes o desordenados en {serie_id}: {anterior[0]} a {actual[0]}")
        resultado[serie_id] = SerieLeida(
            serie_id=serie_id, archivo=archivo.clave, hoja=archivo.hoja,
            fila_origen=fila_valores + 1, observaciones=tuple(observaciones), notas=tuple(notas),
        )

    faltantes = set(archivo.series.values()) - set(resultado)
    if faltantes:
        raise ErrorParseo(f"Faltan series esperadas en {archivo.hoja}: {', '.join(sorted(faltantes))}")
    return resultado
