"""Prueba de calidad del modelo local: unos casos con respuesta conocida, pasados por el mismo prompt y el mismo validador.

Que el servidor conteste no dice nada sobre si el modelo sirve para esto. Esta prueba lo mide: cuántos casos clasifica como
corresponde y cuántas veces el validador tuvo que corregirle algo. No toca la base de datos. Los casos no repiten el del
ejemplo que lleva el prompt, para que acertar no sea copiar.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import date
from typing import Callable

from servicio_datos.agente.analista import construir_mensajes
from servicio_datos.agente.dictamen import Hecho, validar_dictamen
from servicio_datos.agente.modelo import ErrorModelo, ModeloLocal


@dataclass(frozen=True)
class Caso:
    nombre: str
    hallazgo: dict
    hechos: tuple[Hecho, ...]
    esperado: str


def _hallazgo(regla, severidad, serie, periodo, detalle):
    return {"regla": regla, "severidad": severidad, "serie_id": None, "serie_nombre": serie, "periodo": periodo, "detalle": detalle}


CASOS = (
    Caso("un salto que se ve en una sola serie y se revierte",
         _hallazgo("salto_mensual", "media", "IPC nivel general - Patagonia", date(2026, 4, 1), "ipc_ng_patagonia varió 28.40% en 2026-04; supera el umbral de 20%."),
         (Hecho(1, "IPC nivel general - Patagonia: el índice pasa de 104,20 a 133,80 en abr 2026 (+28,4%).", frozenset({"valor"})),
          Hecho(2, "Ninguna de las otras 6 series se mueve más de 2,1% ese mes: el salto es propio de esta serie.", frozenset({"aislado"})),
          Hecho(3, "Al mes siguiente el valor vuelve a 105,50, cerca del nivel anterior (104,20): el salto se revierte.", frozenset({"revierte"}))),
         "posible_error_de_carga"),
    Caso("un salto que se ve en todas las series y se sostiene",
         _hallazgo("salto_mensual", "media", "IPC nivel general - Argentina", date(2026, 5, 1), "ipc_ng_nacional varió 24.80% en 2026-05; supera el umbral de 20%."),
         (Hecho(1, "IPC nivel general - Argentina: el índice pasa de 110,00 a 137,28 en may 2026 (+24,8%).", frozenset({"valor"})),
          Hecho(2, "En may 2026, 6 de las otras 6 series también se mueven en el mismo sentido (entre +23,1% y +26,9%): no es algo propio de esta serie.", frozenset({"sistemico"})),
          Hecho(3, "El nivel nuevo se mantiene: al mes siguiente la serie varía +3,2%.", frozenset({"persistente"}))),
         "dato_real"),
    Caso("una nota sobre cómo se leyó un encabezado",
         _hallazgo("fecha_normalizada", "baja", "IPC nivel general - Cuyo", None, "ipc_ng_cuyo: Encabezado 2026-06-30 interpretado como período mensual 2026-06."),
         (Hecho(1, "El parser registró: Encabezado 2026-06-30 interpretado como período mensual 2026-06.", frozenset({"cosmetico"})),
          Hecho(2, "Esa nota no modifica ningún valor: solo dice cómo se interpretó el encabezado del mes.", frozenset({"cosmetico"}))),
         "cosmetico"),
    Caso("una serie que llega más corta porque su archivo es más viejo",
         _hallazgo("cobertura", "alta", "IPC nivel general - Noreste", date(2026, 6, 1), "ipc_ng_nea termina en 2026-06; otras series llegan a 2026-07."),
         (Hecho(1, "La serie IPC nivel general - Noreste termina en jun 2026; las que más avanzan llegan a jul 2026.", frozenset({"valor"})),
          Hecho(2, "Según el servidor de INDEC, el archivo de esta serie (sh_ipc_07_26.xls) cambió por última vez el 14 de julio de 2026 y el de las que están al día (sh_ipc_aperturas.xls) el 12 de agosto de 2026, 29 días después.",
                frozenset({"archivo"}))),
         "desfase_de_archivo"),
    Caso("un aviso del que los hechos no dicen nada concluyente",
         _hallazgo("frescura", "media", "IPC nivel general - Argentina", date(2026, 6, 1), "ipc_ng_nacional llega a 2026-06; al 2026-09-10 se esperaba al menos 2026-08."),
         (Hecho(1, "La validación informó: ipc_ng_nacional llega a 2026-06; al 2026-09-10 se esperaba al menos 2026-08.", frozenset({"valor"})),
          Hecho(2, "Últimos valores de la serie: abr 2026 108,00, may 2026 109,00, jun 2026 110,00.", frozenset())),
         "requiere_revision_humana"),
)


@dataclass(frozen=True)
class ResultadoCaso:
    nombre: str
    esperado: str
    obtenido: str | None  # None: el modelo no contestó algo utilizable
    corregido: bool  # el validador tuvo que cambiarle algo a lo que dijo el modelo
    segundos: float
    error: str | None = None

    @property
    def acierta(self) -> bool:
        return self.obtenido == self.esperado


def correr(modelo: ModeloLocal, casos: tuple[Caso, ...] = CASOS, reloj: Callable[[], float] = time.monotonic) -> list[ResultadoCaso]:
    """Pasa cada caso por el modelo. Si el servidor falla (no es que conteste mal), el error se propaga: no hay nada que medir."""
    resultados = []
    for caso in casos:
        inicio = reloj()
        try:
            crudo = modelo.consultar_json(construir_mensajes(caso.hallazgo, list(caso.hechos)))
        except ErrorModelo as error:
            if type(error) is not ErrorModelo:  # el servidor no está: se corta
                raise
            resultados.append(ResultadoCaso(caso.nombre, caso.esperado, None, False, reloj() - inicio, str(error)))
            continue
        dictamen = validar_dictamen(crudo, list(caso.hechos))
        resultados.append(ResultadoCaso(caso.nombre, caso.esperado, dictamen.clasificacion, bool(dictamen.notas), reloj() - inicio))
    return resultados
