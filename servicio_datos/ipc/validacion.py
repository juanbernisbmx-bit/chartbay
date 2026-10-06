"""Controles determinísticos del IPC; solo emiten hallazgos, no corrigen datos."""
from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Mapping, Sequence
from zoneinfo import ZoneInfo

from servicio_datos.ipc import fuente
from servicio_datos.ipc.modelos import DescargaRegistrada, Hallazgo, SerieLeida

# Umbrales de revisión iniciales: ajustar con Juani tras revisar el historial.
SALTO_MENSUAL_ALERTA_PCT = Decimal("20")
DIA_LIMITE_PUBLICACION = 25
ZONA_PUBLICACION = ZoneInfo("America/Argentina/Buenos_Aires")
SERIES_ESPERADAS = frozenset({"ipc_ng_nacional", *fuente.REGIONES.values()})


def _mes(periodo: date) -> int:
    return periodo.year * 12 + periodo.month - 1


def _fecha_mes(indice: int) -> date:
    return date(indice // 12, indice % 12 + 1, 1)


def validar(
    series: Mapping[str, SerieLeida],
    vigentes: Mapping[str, Mapping[date, Decimal]],
    descargas: Sequence[DescargaRegistrada],
    *,
    hoy: date | None = None,
) -> list[Hallazgo]:
    """Compara siete series leídas con el release vigente y el calendario.

    La ausencia o anomalía produce un hallazgo, nunca un valor corregido.
    `hoy` permite probar la regla temporal sin depender del reloj del servidor.
    """
    hoy = hoy or datetime.now(ZONA_PUBLICACION).date()
    hallazgos: list[Hallazgo] = []

    def agregar(regla: str, severidad: str, serie_id: str | None, periodo: date | None, detalle: str) -> None:
        hallazgos.append(Hallazgo(regla, severidad, serie_id, periodo, detalle))

    for serie_id in sorted(SERIES_ESPERADAS - set(series)):
        agregar("estructura", "alta", serie_id, None, f"Falta la serie esperada {serie_id}.")
    for serie_id in sorted(set(series) - SERIES_ESPERADAS):
        agregar("estructura", "alta", serie_id, None, f"La serie {serie_id} no pertenece al IPC configurado.")

    valores: dict[str, dict[date, Decimal]] = {}
    ultimos: dict[str, date] = {}
    for serie_id, serie in series.items():
        if serie.serie_id != serie_id:
            agregar("estructura", "alta", serie_id, None,
                    f"La clave {serie_id} no coincide con el identificador interno {serie.serie_id}.")
        if not serie.observaciones:
            agregar("estructura", "alta", serie_id, None, f"La serie {serie_id} está vacía.")
            continue
        if serie.observaciones[0] != (date(2016, 12, 1), Decimal("100")):
            agregar("base_referencia", "alta", serie_id, serie.observaciones[0][0],
                    f"{serie_id} ya no inicia en diciembre de 2016 con índice 100.")

        mapa: dict[date, Decimal] = {}
        anterior: tuple[date, Decimal] | None = None
        for periodo, valor in serie.observaciones:
            if periodo.day != 1 or (anterior and _mes(periodo) - _mes(anterior[0]) != 1):
                agregar("continuidad", "alta", serie_id, periodo,
                        f"{serie_id} tiene un mes ausente, repetido, desordenado o con día distinto del primero: {periodo}.")
            if not valor.is_finite() or valor <= 0:
                agregar("rango", "alta", serie_id, periodo,
                        f"{serie_id} tiene un índice no positivo o no finito en {periodo}.")
            elif anterior and anterior[1].is_finite() and anterior[1] > 0 and _mes(periodo) - _mes(anterior[0]) == 1:
                variacion = (valor / anterior[1] - 1) * 100
                if abs(variacion) > SALTO_MENSUAL_ALERTA_PCT:
                    agregar("salto_mensual", "media", serie_id, periodo,
                            f"{serie_id} varió {variacion:.2f}% en {periodo}; supera el umbral de {SALTO_MENSUAL_ALERTA_PCT}%.")
            mapa[periodo] = valor
            anterior = (periodo, valor)
        valores[serie_id] = mapa
        ultimos[serie_id] = serie.observaciones[-1][0]

        for nota in serie.notas:
            agregar("fecha_normalizada", "baja", serie_id, None, f"{serie_id}: {nota}.")
        for periodo, anterior_publicado in vigentes.get(serie_id, {}).items():
            actual = mapa.get(periodo)
            if actual is None:
                agregar("historia_intacta", "alta", serie_id, periodo,
                        f"{serie_id}: el período {periodo} publicado antes falta en el archivo nuevo.")
            elif actual != anterior_publicado:
                agregar("historia_intacta", "alta", serie_id, periodo,
                        f"{serie_id}: {periodo} pasó de {anterior_publicado} a {actual}.")

    if ultimos:
        maximo = max(ultimos.values())
        for serie_id, ultimo in ultimos.items():
            if ultimo != maximo:
                agregar("cobertura", "alta", serie_id, ultimo,
                        f"{serie_id} termina en {ultimo:%Y-%m}; otras series llegan a {maximo:%Y-%m}.")

    nacional = valores.get("ipc_ng_nacional", {})
    regiones = [valores.get(serie_id, {}) for serie_id in fuente.REGIONES.values()]
    for periodo, valor in nacional.items():
        if not all(periodo in region for region in regiones):
            continue
        regionales = [region[periodo] for region in regiones]
        if not valor.is_finite() or not all(regional.is_finite() for regional in regionales):
            continue
        if valor < min(regionales) or valor > max(regionales):
            agregar("cruce_regional", "media", "ipc_ng_nacional", periodo,
                    f"IPC nacional {valor} fuera del rango regional [{min(regionales)}, {max(regionales)}] en {periodo}.")

    # Antes del día límite se espera como mínimo el mes antepasado; después,
    # el mes anterior. Es una alerta conservadora, no una fecha oficial exacta.
    mes_esperado = _mes(hoy) - (1 if hoy.day > DIA_LIMITE_PUBLICACION else 2)
    esperado = _fecha_mes(mes_esperado)
    archivos_descargados = {descarga.clave for descarga in descargas}
    for serie_id, ultimo in ultimos.items():
        if series[serie_id].archivo in archivos_descargados and ultimo < esperado:
            agregar("frescura", "media", serie_id, ultimo,
                    f"{serie_id} llega a {ultimo:%Y-%m}; al {hoy} se esperaba al menos {esperado:%Y-%m}.")
    return hallazgos
