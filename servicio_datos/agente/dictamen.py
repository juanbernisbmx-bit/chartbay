"""El dictamen del modelo y el validador que decide qué parte de él se acepta.

Con un modelo local, chico, no se puede confiar en lo que devuelve: puede inventar una cita, exagerar su
seguridad o proponer algo incoherente. Por eso el modelo NO tiene la última palabra sobre nada que importe. Este
módulo, que es código común y probado, la tiene:

- Solo se acepta lo que el modelo puede respaldar con hechos que reunió el código (`Hecho`), citados por número.
  Una cita a un hecho que no existe se descarta; sin ninguna cita válida, el dictamen es "requiere revisión humana".
- Cada clasificación exige que, entre los hechos citados, haya uno de la clase que la sostiene: no se puede decir
  "el archivo está atrasado" si el código no encontró un dato de fechas de archivo, ni "es un error de carga" si el
  salto no resultó aislado o no revirtió.
- La acción tiene que ser coherente con la clasificación, y la confianza alta exige al menos dos hechos citados.
- Lo que se baja o se descarta queda anotado en `notas`, para auditar qué corrigió el validador.

El resultado nunca es más seguro de sí mismo que lo que la evidencia permite.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Mapping, Sequence

CLASIFICACIONES = ("dato_real", "cosmetico", "posible_error_de_carga", "desfase_de_archivo", "cambio_de_base", "requiere_revision_humana")
ACCIONES = ("aceptar", "rechazar", "investigar")
CONFIANZAS = ("baja", "media", "alta")

# Qué acciones tienen sentido para cada clasificación.
ACCIONES_COHERENTES: Mapping[str, frozenset[str]] = {
    "dato_real": frozenset({"aceptar", "investigar"}),
    "cosmetico": frozenset({"aceptar", "investigar"}),
    "posible_error_de_carga": frozenset({"rechazar", "investigar"}),
    "desfase_de_archivo": frozenset({"rechazar", "investigar"}),
    "cambio_de_base": frozenset({"investigar"}),
    "requiere_revision_humana": frozenset({"investigar"}),
}
# Etiquetas de hecho: al menos una de estas tiene que estar entre los hechos citados para sostener la clasificación.
REQUISITOS: Mapping[str, frozenset[str]] = {
    "dato_real": frozenset({"sistemico", "persistente", "precedente"}),
    "cosmetico": frozenset({"cosmetico", "precedente"}),
    "posible_error_de_carga": frozenset({"aislado", "revierte"}),
    "desfase_de_archivo": frozenset({"archivo"}),
    "cambio_de_base": frozenset({"base"}),
}
# Lo mismo, dicho para quien revisa: va en la nota cuando el validador baja una conclusión.
EXPLICACION_REQUISITOS: Mapping[str, str] = {
    "dato_real": "que el movimiento se ve en varias series a la vez, que el nivel se mantiene o que una persona ya lo aceptó antes",
    "cosmetico": "que es una nota del parser sobre cómo leyó el archivo, o que una persona ya la aceptó antes",
    "posible_error_de_carga": "que el salto es propio de esta serie o que se revierte",
    "desfase_de_archivo": "que el archivo de esta serie es más viejo que el de las demás",
    "cambio_de_base": "que la serie ya no arranca en la base de referencia",
}
MAX_RAZONAMIENTO = 600


@dataclass(frozen=True)
class Hecho:
    """Algo que el código comprobó en los datos. El modelo lo cita por `id`; no puede inventar uno."""

    id: int
    texto: str
    etiquetas: frozenset[str] = frozenset()


@dataclass(frozen=True)
class Dictamen:
    clasificacion: str
    accion_sugerida: str
    confianza: str
    razonamiento: str  # lo que dijo el modelo, limpio y acotado; vacío si no dijo nada (nunca una frase inventada por el sistema)
    hechos_citados: tuple[int, ...]
    notas: tuple[str, ...] = field(default=())  # lo que el validador cambió respecto de lo que dijo el modelo


def _limpiar(texto: str) -> str:
    texto = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", texto)
    texto = re.sub(r"\s+", " ", texto).strip()
    return texto if len(texto) <= MAX_RAZONAMIENTO else texto[: MAX_RAZONAMIENTO - 1].rstrip() + "…"


def _sin_dictamen(motivo: str, razonamiento: str = "") -> Dictamen:
    return Dictamen("requiere_revision_humana", "investigar", "baja", razonamiento, (), (motivo,))


def validar_dictamen(crudo: object, hechos: Sequence[Hecho]) -> Dictamen:
    """Lo que dijo el modelo, ya filtrado: nunca más seguro ni más específico que lo que la evidencia sostiene."""
    if not isinstance(crudo, dict):
        return _sin_dictamen("El modelo no devolvió un objeto JSON.")
    notas: list[str] = []
    por_id = {h.id: h for h in hechos}

    clasificacion = crudo.get("clasificacion")
    if clasificacion not in CLASIFICACIONES:
        clasificacion = "requiere_revision_humana"
        notas.append("La clasificación no era una de las permitidas.")
    accion = crudo.get("accion_sugerida")
    if accion not in ACCIONES:
        accion = "investigar"
        notas.append("La acción no era una de las permitidas.")
    confianza = crudo.get("confianza")
    if confianza not in CONFIANZAS:
        confianza = "baja"
        notas.append("La confianza no era una de las permitidas.")

    crudas = crudo.get("hechos_citados")
    citas: list[int] = []
    for cita in crudas if isinstance(crudas, list) else []:
        if isinstance(cita, int) and not isinstance(cita, bool) and cita in por_id and cita not in citas:
            citas.append(cita)
    if isinstance(crudas, list) and len(citas) < len(set(map(str, crudas))):
        notas.append("Se descartaron citas a hechos que no existen.")
    razonamiento = _limpiar(crudo["razonamiento"]) if isinstance(crudo.get("razonamiento"), str) else ""

    if not citas:
        return _sin_dictamen("No citó ningún hecho: sin evidencia no hay propuesta.", razonamiento)
    etiquetas = set().union(*(por_id[c].etiquetas for c in citas))

    if clasificacion in REQUISITOS and not (REQUISITOS[clasificacion] & etiquetas):
        notas.append(f"Para decir «{clasificacion}» hace falta citar un hecho que muestre {EXPLICACION_REQUISITOS[clasificacion]}, y no lo hizo.")
        clasificacion, accion, confianza = "requiere_revision_humana", "investigar", "baja"
    if accion not in ACCIONES_COHERENTES[clasificacion]:
        notas.append(f"La acción «{accion}» no es coherente con «{clasificacion}».")
        accion, confianza = "investigar", "baja"
    if clasificacion == "requiere_revision_humana":
        accion, confianza = "investigar", "baja"
    if confianza == "alta" and len(citas) < 2:
        notas.append("La confianza alta exige al menos dos hechos citados.")
        confianza = "media"
    return Dictamen(clasificacion, accion, confianza, razonamiento, tuple(citas), tuple(notas))
