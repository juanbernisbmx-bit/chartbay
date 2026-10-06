"""Gráfico de una serie para la pantalla de revisión, como SVG armado en el servidor.

Sin JavaScript ni librerías: la pantalla funciona igual con los scripts desactivados. Todo lo
que entra al SVG son números o texto escapado.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal
from html import escape
from typing import Sequence

Puntos = Sequence[tuple[date, Decimal]]
MESES = ("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic")


def numero(valor: Decimal | float | None, decimales: int = 0) -> str:
    """10714.6255 -> 10.714,6255 (punto de miles, coma decimal)."""
    if valor is None:
        return "—"
    return f"{valor:,.{decimales}f}".translate(str.maketrans(",.", ".,"))


def mes(periodo: date) -> str:
    return f"{MESES[periodo.month - 1]} {periodo.year}"


def _indice(periodo: date) -> int:
    return periodo.year * 12 + periodo.month - 1


def ventana(puntos: Puntos, centro: date | None, meses: int = 18) -> list[tuple[date, Decimal]]:
    """Los puntos alrededor de un período; sin período, los últimos `2 * meses`."""
    if centro is None:
        return list(puntos[-2 * meses:])
    return [p for p in puntos if abs(_indice(p[0]) - _indice(centro)) <= meses]


def linea(
    candidato: Puntos, vigente: Puntos | None = None, resaltado: date | None = None, titulo: str = "",
    uid: str = "g", ancho: int = 560, alto: int = 150,
) -> str:
    """Línea del candidato (y, si difiere, la de lo vigente en punteado) con el período resaltado."""
    if len(candidato) < 2:
        return ""
    izq, der, arriba, abajo = 46, 10, 12, 24
    todos = [float(v) for _, v in candidato] + [float(v) for _, v in (vigente or [])]
    minimo, maximo = min(todos), max(todos)
    if maximo == minimo:
        maximo, minimo = maximo + 1, minimo - 1
    periodos = [_indice(p) for p, _ in candidato] + [_indice(p) for p, _ in (vigente or [])]
    primero, ultimo = min(periodos), max(periodos)
    amplitud = max(ultimo - primero, 1)

    def x(periodo: date) -> float:
        return izq + (_indice(periodo) - primero) / amplitud * (ancho - izq - der)

    def y(valor: Decimal) -> float:
        return arriba + (1 - (float(valor) - minimo) / (maximo - minimo)) * (alto - arriba - abajo)

    def camino(puntos: Puntos) -> str:
        return " ".join(f"{'M' if i == 0 else 'L'}{x(p):.1f} {y(v):.1f}" for i, (p, v) in enumerate(puntos))

    partes = [
        f'<svg class="grafico" viewBox="0 0 {ancho} {alto}" role="img" aria-labelledby="t-{escape(uid)}">',
        f'<title id="t-{escape(uid)}">{escape(titulo)}</title>',
        f'<line class="lin-eje" x1="{izq}" y1="{arriba}" x2="{izq}" y2="{alto - abajo}"/>',
        f'<line class="lin-eje" x1="{izq}" y1="{alto - abajo}" x2="{ancho - der}" y2="{alto - abajo}"/>',
        f'<text class="lin-texto" x="{izq - 6}" y="{arriba + 4}" text-anchor="end">{numero(maximo)}</text>',
        f'<text class="lin-texto" x="{izq - 6}" y="{alto - abajo}" text-anchor="end">{numero(minimo)}</text>',
        f'<text class="lin-texto" x="{izq}" y="{alto - 6}" text-anchor="start">{escape(mes(candidato[0][0]))}</text>',
        f'<text class="lin-texto" x="{ancho - der}" y="{alto - 6}" text-anchor="end">{escape(mes(candidato[-1][0]))}</text>',
    ]
    if vigente and len(vigente) > 1 and [(p, v) for p, v in vigente] != [(p, v) for p, v in candidato]:
        partes.append(f'<path class="lin-vigente" d="{camino(vigente)}"/>')
    partes.append(f'<path class="lin-candidato" d="{camino(candidato)}"/>')
    if resaltado is not None:
        valor = dict(candidato).get(resaltado)
        if valor is not None:
            partes.append(f'<circle class="lin-resalte" cx="{x(resaltado):.1f}" cy="{y(valor):.1f}" r="4.5"/>')
    partes.append("</svg>")
    return "".join(partes)
