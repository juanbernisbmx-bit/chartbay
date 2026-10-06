"""Lo que el código comprueba en los datos para cada hallazgo: la evidencia sobre la que el modelo razona.

El modelo no busca nada ni consulta la base: recibe una lista numerada de hechos ya comprobados y solo puede citarlos.
Cada hecho lleva etiquetas que dicen de qué clase es, y `dictamen.validar_dictamen` exige la clase correcta para sostener
cada afirmación (por ejemplo, "el archivo está atrasado" solo se puede decir si hay un hecho `archivo`).

Los hechos salen de comparar la serie con las demás en el mismo mes, con el mes siguiente, con lo ya publicado y con las
fechas de los archivos. Todo es determinístico: el mismo candidato da siempre los mismos hechos.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Mapping

import psycopg
from psycopg.rows import dict_row

from servicio_datos import repositorio
from servicio_datos.agente.dictamen import Hecho

MESES = ("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")
MESES_LARGOS = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre")

MAX_HECHO = 400

Serie = Mapping[date, Decimal]
Colectado = list[tuple[str, set[str]]]  # (texto, etiquetas)


@dataclass(frozen=True)
class Archivo:
    nombre: str
    publicada_en: datetime | None


@dataclass(frozen=True)
class Contexto:
    """Todo lo que hace falta saber de un candidato para reunir hechos, cargado una sola vez."""

    candidato: Mapping[str, Serie]  # lo que propone el candidato, por serie
    vigente: Mapping[str, Serie]  # lo que está publicado hoy
    archivos: Mapping[str, Archivo]  # de qué archivo salió cada serie
    release_vigente: tuple[str, datetime] | None  # (release_id, publicado_en)


def _mes(periodo: date) -> str:
    return f"{MESES[periodo.month - 1]} {periodo.year}"


def fecha_larga(momento: datetime) -> str:
    return f"{momento.day} de {MESES_LARGOS[momento.month - 1]} de {momento.year}"


def _num(valor: Decimal) -> str:
    return f"{valor:,.2f}".translate(str.maketrans(",.", ".,"))


def _pct(valor: Decimal) -> str:
    return f"{valor:+.1f}%".replace(".", ",")


def _mover(periodo: date, meses: int) -> date:
    indice = periodo.year * 12 + periodo.month - 1 + meses
    return date(indice // 12, indice % 12 + 1, 1)


def _variacion(serie: Serie, periodo: date) -> Decimal | None:
    anterior = serie.get(_mover(periodo, -1))
    return (serie[periodo] / anterior - 1) * 100 if periodo in serie and anterior else None


def cargar_contexto(conn: psycopg.Connection, candidato_id: int) -> Contexto:
    fuente_id, resumen = conn.execute(
        "SELECT co.fuente_id, co.resumen FROM candidato c JOIN corrida co ON co.id = c.corrida_id WHERE c.id = %s", (candidato_id,)).fetchone()
    candidato: dict[str, dict[date, Decimal]] = {}
    for serie_id, periodo, valor in conn.execute("SELECT serie_id, periodo, valor FROM observacion_candidata WHERE candidato_id = %s", (candidato_id,)):
        candidato.setdefault(serie_id, {})[periodo] = valor

    por_clave = {a["clave"]: Archivo(a["url"].rsplit("/", 1)[-1], datetime.fromisoformat(a["publicada_en"]) if a.get("publicada_en") else None)
                 for a in resumen.get("archivos", [])}
    archivos = {sid: por_clave[d["archivo"]] for sid, d in resumen.get("detalle_series", {}).items() if d.get("archivo") in por_clave}
    release = conn.execute(
        "SELECT r.release_id, r.publicado_en FROM release r JOIN candidato c ON c.id = r.candidato_id "
        "JOIN corrida co ON co.id = c.corrida_id WHERE co.fuente_id = %s ORDER BY r.numero DESC LIMIT 1", (fuente_id,)).fetchone()
    return Contexto(candidato, repositorio.vigentes(conn, fuente_id), archivos, tuple(release) if release else None)


def _salto_mensual(ctx: Contexto, h: Mapping) -> Colectado:
    serie, periodo = h["serie_id"], h["periodo"]
    valores = ctx.candidato.get(serie or "", {})
    var = _variacion(valores, periodo) if periodo else None
    if var is None:
        return [("No hay datos suficientes de esa serie para comparar el mes con el anterior.", set())]
    nombre = h.get("serie_nombre") or serie
    anterior, actual = valores[_mover(periodo, -1)], valores[periodo]
    hechos: Colectado = [(f"{nombre}: el índice pasa de {_num(anterior)} a {_num(actual)} en {_mes(periodo)} ({_pct(var)}).", {"valor"})]

    otras = [(t, v) for t, vt in ctx.candidato.items() if t != serie and (v := _variacion(vt, periodo)) is not None]
    if otras:
        mismas = [v for _, v in otras if v * var > 0 and abs(v) >= abs(var) / 2]
        mayor = max(abs(v) for _, v in otras)
        if len(mismas) / len(otras) >= 0.8:
            hechos.append((f"En {_mes(periodo)}, {len(mismas)} de las otras {len(otras)} series también se mueven en el mismo sentido (entre {_pct(min(mismas, key=abs))} y {_pct(max(mismas, key=abs))}): no es algo propio de esta serie.", {"sistemico"}))
        elif mayor < abs(var) / 4:
            hechos.append((f"Ninguna de las otras {len(otras)} series se mueve más de {_pct(mayor)[1:]} ese mes: el salto es propio de esta serie.", {"aislado"}))
        else:
            hechos.append((f"En {_mes(periodo)}, {len(mismas)} de las otras {len(otras)} series se mueven en el mismo sentido y con una magnitud parecida.", set()))

    siguiente = valores.get(_mover(periodo, 1))
    if siguiente is None:
        hechos.append(("Es el último mes cargado: todavía no hay un mes siguiente para ver si el nivel se mantiene.", set()))
    elif abs(siguiente - anterior) < Decimal("0.25") * abs(actual - anterior):
        hechos.append((f"Al mes siguiente el valor vuelve a {_num(siguiente)}, cerca del nivel anterior ({_num(anterior)}): el salto se revierte.", {"revierte"}))
    elif abs(siguiente / actual * 100 - 100) < abs(var) / 2:
        hechos.append((f"El nivel nuevo se mantiene: al mes siguiente la serie varía {_pct(siguiente / actual * 100 - 100)}.", {"persistente"}))
    else:
        hechos.append((f"Al mes siguiente la serie varía {_pct(siguiente / actual * 100 - 100)}.", set()))

    if ctx.vigente.get(serie, {}).get(periodo) == actual:
        hechos.append((f"Ese mes ya figura publicado con este mismo valor ({ctx.release_vigente[0] if ctx.release_vigente else 'release vigente'}): no es un dato nuevo.", {"ya_publicado"}))
    return hechos


def _historia_intacta(ctx: Contexto, h: Mapping) -> Colectado:
    serie, periodo = h["serie_id"], h["periodo"]
    publicado, nuevo = ctx.vigente.get(serie or "", {}).get(periodo), ctx.candidato.get(serie or "", {}).get(periodo)
    if publicado is None or periodo is None:
        return [("No se encontró el valor publicado de ese período para comparar.", set())]
    nombre = h.get("serie_nombre") or serie
    if nuevo is None:
        hechos: Colectado = [(f"{nombre}: el período {_mes(periodo)} está publicado ({_num(publicado)}) pero falta en el candidato.", {"valor"})]
    else:
        hechos = [(f"{nombre}: el valor publicado de {_mes(periodo)} era {_num(publicado)} y el candidato trae {_num(nuevo)} ({_pct((nuevo / publicado - 1) * 100)}).", {"valor"})]

    def difiere(sid: str, p: date) -> bool:
        return ctx.candidato.get(sid, {}).get(p) != ctx.vigente[sid][p]

    cambian = sorted(p for p in ctx.vigente[serie] if difiere(serie, p))
    if len(cambian) > 1:
        hechos.append((f"En esta serie cambian {len(cambian)} períodos ya publicados (entre {_mes(cambian[0])} y {_mes(cambian[-1])}): parece una revisión y no un valor suelto.", {"revision"}))
    con_cambios = [sid for sid in ctx.vigente if any(difiere(sid, p) for p in ctx.vigente[sid])]
    if len(ctx.vigente) >= 3 and len(con_cambios) / len(ctx.vigente) >= 0.8:
        hechos.append((f"Cambian datos ya publicados en {len(con_cambios)} de las {len(ctx.vigente)} series.", {"sistemico"}))
    archivo = ctx.archivos.get(serie)
    if archivo and archivo.publicada_en and ctx.release_vigente:
        hechos.append((f"El archivo del dato nuevo ({archivo.nombre}) lo publicó INDEC el {fecha_larga(archivo.publicada_en)}; el release vigente se publicó el {fecha_larga(ctx.release_vigente[1])}.", set()))
    return hechos


def _cobertura(ctx: Contexto, h: Mapping) -> Colectado:
    serie = h["serie_id"]
    if not ctx.candidato.get(serie or ""):
        return [("No hay datos de esa serie en el candidato.", set())]
    ultimos = {sid: max(valores) for sid, valores in ctx.candidato.items() if valores}
    maximo = max(ultimos.values())
    hechos: Colectado = [(f"La serie {h.get('serie_nombre') or serie} termina en {_mes(ultimos[serie])}; las que más avanzan llegan a {_mes(maximo)}.", {"valor"})]
    delante = sorted(sid for sid, ultimo in ultimos.items() if ultimo == maximo)
    mia, otra = ctx.archivos.get(serie), ctx.archivos.get(delante[0])
    if mia and otra and mia.publicada_en and otra.publicada_en:
        dias = (otra.publicada_en - mia.publicada_en).days
        if mia.nombre != otra.nombre and dias >= 1:
            hechos.append((f"El archivo de esta serie ({mia.nombre}) se publicó el {fecha_larga(mia.publicada_en)} y el de las que están al día ({otra.nombre}) el {fecha_larga(otra.publicada_en)}, {dias} días después.", {"archivo"}))
        elif mia.nombre == otra.nombre:
            hechos.append((f"Las dos salen del mismo archivo ({mia.nombre}): el desfase no se explica por archivos distintos.", set()))
        else:
            hechos.append((f"Los dos archivos ({mia.nombre} y {otra.nombre}) se publicaron el mismo día o con el de esta serie después: no hay un desfase de publicación que explique la diferencia.", set()))
    else:
        hechos.append(("No hay fechas de publicación de los archivos para comparar.", set()))
    return hechos


def _base_referencia(ctx: Contexto, h: Mapping) -> Colectado:
    serie = h["serie_id"]
    valores = ctx.candidato.get(serie or "", {})
    if not valores:
        return [("No hay datos de esa serie en el candidato.", set())]
    primero = min(valores)
    hechos: Colectado = [(f"{h.get('serie_nombre') or serie}: el primer valor del candidato es {_num(valores[primero])} en {_mes(primero)}; lo esperado es 100,00 en dic 2016.", {"base"})]
    publicado = ctx.vigente.get(serie or "", {})
    if publicado:
        base = min(publicado)
        hechos.append((f"En el release vigente la serie arranca en {_mes(base)} con {_num(publicado[base])}.", set()))
    return hechos


def _fecha_normalizada(ctx: Contexto, h: Mapping) -> Colectado:
    detalle = (h["detalle"] or "").split(": ", 1)[-1].rstrip(".")
    return [(f"El parser registró: {detalle}.", {"cosmetico"}),
            ("Esa nota no modifica ningún valor: solo dice cómo se interpretó el encabezado del mes.", {"cosmetico"})]


def _generico(ctx: Contexto, h: Mapping) -> Colectado:
    hechos: Colectado = [(f"La validación informó: {h['detalle']}", {"valor"})]
    valores = ctx.candidato.get(h["serie_id"] or "", {})
    if valores:
        hechos.append(("Últimos valores de la serie: " + ", ".join(f"{_mes(p)} {_num(valores[p])}" for p in sorted(valores)[-3:]) + ".", set()))
    archivo = ctx.archivos.get(h["serie_id"] or "")
    if archivo and archivo.publicada_en:
        hechos.append((f"El archivo de esta serie ({archivo.nombre}) lo publicó INDEC el {fecha_larga(archivo.publicada_en)}.", set()))
    return hechos


COLECTORES = {"salto_mensual": _salto_mensual, "historia_intacta": _historia_intacta, "cobertura": _cobertura,
              "base_referencia": _base_referencia, "fecha_normalizada": _fecha_normalizada}


def limpiar_texto(texto: str) -> str:
    """Algunos hechos repiten texto que viene del archivo de la fuente (p. ej. un encabezado): sin controles y con tope."""
    texto = re.sub(r"\s+", " ", re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", texto)).strip()
    return texto if len(texto) <= MAX_HECHO else texto[: MAX_HECHO - 1].rstrip() + "…"


def reunir_hechos(ctx: Contexto, hallazgo: Mapping) -> list[Hecho]:
    """Los hechos comprobados sobre un hallazgo, numerados desde 1."""
    return [Hecho(i, limpiar_texto(texto), frozenset(etiquetas)) for i, (texto, etiquetas) in enumerate(COLECTORES.get(hallazgo["regla"], _generico)(ctx, hallazgo), 1)]


def buscar_precedente(conn: psycopg.Connection, candidato_id: int, hallazgo: Mapping) -> dict | None:
    """La decisión más reciente que una persona tomó sobre un hallazgo idéntico de otro candidato, si la hubo."""
    with conn.cursor(row_factory=dict_row) as cursor:
        cursor.execute(
            "SELECT u.decision, u.revisor, u.comentario, u.decidida_en, c2.id AS candidato_id "
            "FROM hallazgo h2 JOIN candidato c2 ON c2.corrida_id = h2.corrida_id AND c2.id <> %(c)s "
            "JOIN LATERAL (SELECT decision, revisor, comentario, decidida_en FROM revision_hallazgo r WHERE r.hallazgo_id = h2.id ORDER BY r.id DESC LIMIT 1) u ON true "
            "WHERE h2.regla = %(regla)s AND h2.serie_id IS NOT DISTINCT FROM %(serie)s AND h2.periodo IS NOT DISTINCT FROM %(periodo)s "
            "AND h2.detalle IS NOT DISTINCT FROM %(detalle)s ORDER BY u.decidida_en DESC LIMIT 1",
            {"c": candidato_id, "regla": hallazgo["regla"], "serie": hallazgo["serie_id"], "periodo": hallazgo["periodo"], "detalle": hallazgo["detalle"]},
        )
        return cursor.fetchone()
