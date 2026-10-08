"""Lo que el código comprueba en los datos para cada hallazgo: la evidencia sobre la que el modelo razona.

El modelo no busca nada ni consulta la base: recibe una lista numerada de hechos ya comprobados y solo puede citarlos.
Cada hecho lleva etiquetas que dicen de qué clase es, y el validador exige la clase correcta para sostener cada afirmación
(por ejemplo, "el archivo está atrasado" solo se puede decir si hay un hecho `archivo`).

Los hechos los reúne la base (`hechos_de`, migración 0015): comparan la serie con las demás en el mismo mes, con el mes
siguiente, con lo ya publicado y con las fechas de los archivos. Son las mismas que usa la Edge Function `analizar`, y la base
los vuelve a calcular al guardar una propuesta, así que nadie puede presentarle al validador hechos que no salieron de ahí.
"""
from __future__ import annotations

import re
from datetime import datetime

import psycopg

from servicio_datos.agente.dictamen import Hecho

MAX_HECHO = 400


def limpiar_texto(texto: str) -> str:
    """Algunos textos vienen del archivo de la fuente (p. ej. un encabezado): sin controles y con tope. Como `limpiar_texto` en la base."""
    texto = re.sub(r"\s+", " ", re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", texto)).strip()
    return texto if len(texto) <= MAX_HECHO else texto[: MAX_HECHO - 1].rstrip() + "…"


def reunir_hechos(conn: psycopg.Connection, hallazgo_id: int) -> list[Hecho]:
    """Los hechos comprobados sobre un hallazgo, numerados desde 1."""
    hechos = conn.execute("SELECT hechos_de(%s)", (hallazgo_id,)).fetchone()[0]
    return [Hecho(h["id"], h["texto"], frozenset(h["etiquetas"])) for h in hechos]


def buscar_precedente(conn: psycopg.Connection, hallazgo_id: int) -> dict | None:
    """La decisión más reciente que una persona tomó sobre un hallazgo idéntico de otro candidato, si la hubo."""
    precedente = conn.execute("SELECT precedente_de(%s)", (hallazgo_id,)).fetchone()[0]
    if precedente is None:
        return None
    return {**precedente, "decidida_en": datetime.fromisoformat(precedente["decidida_en"])}
