"""
Notebook de práctica del manual de ChartPython.

Los ejemplos del manual se escriben una sola vez, en su plantilla
(`templates/chartpython_manual.html`), dentro de bloques `call py()`. Este
módulo los recorre en orden junto con los títulos de cada parte y cada tema y
arma un `.ipynb` (nbformat 4) que se abre en ChartPython con "Abrir .ipynb" o en
cualquier Jupyter.

Quedan afuera los ejemplos que fallan a propósito y los que no se pueden
ejecutar (un bucle infinito), así el notebook corre entero con "Ejecutar todo".
La prueba `quantbay/tests/chartpython/manual.test.ts` recorre la plantilla con la
misma expresión regular y ejecuta cada bloque en el Pyodide de ChartPython.
"""
import html
import json
import re
from pathlib import Path

PLANTILLA = Path(__file__).resolve().parent / "templates" / "chartpython_manual.html"

# Un bloque de ejemplo o un título, en el orden en que aparecen.
_ELEMENTO = re.compile(
    r"\{%-?\s*call\s+(?P<macro>py|salida|salida_error)\((?P<opciones>[^)]*)\)\s*-?%\}"
    r"(?P<cuerpo>.*?)\{%-?\s*endcall\s*-?%\}"
    r"|<h(?P<nivel>[23])\b[^>]*>(?P<titulo>.*?)</h(?P=nivel)>",
    re.S,
)
_OPCION = re.compile(r'(\w+)\s*=\s*(?:"([^"]*)"|(true|false))')
_MARCADO = re.compile(r"<[^>]+>|\{\{.*?\}\}", re.S)


def _opciones(texto: str) -> dict:
    """`error="KeyError", ejecutar=false` -> {"error": "KeyError", "ejecutar": False}."""
    return {
        nombre: (valor if not booleano else booleano == "true")
        for nombre, valor, booleano in _OPCION.findall(texto)
    }


def bloques(fuente: str) -> list:
    """Los bloques de la plantilla, en orden: macro, opciones y texto."""
    return [
        {"macro": m.group("macro"), "opciones": _opciones(m.group("opciones")), "texto": m.group("cuerpo")}
        for m in _ELEMENTO.finditer(fuente)
        if m.group("macro")
    ]


def _ejecutable(opciones: dict) -> bool:
    return not opciones.get("error") and opciones.get("ejecutar", True) is not False


def _lineas(texto: str) -> list:
    return texto.splitlines(keepends=True)


def notebook_de_practica(fuente: str = None, url_manual: str = "") -> str:
    """El .ipynb con los ejemplos ejecutables del manual, como texto JSON."""
    if fuente is None:
        fuente = PLANTILLA.read_text(encoding="utf-8")

    intro = (
        "# Manual de ChartPython: ejemplos\n\n"
        "Son los ejemplos del manual, en el mismo orden. Ejecutalos de arriba hacia "
        "abajo: varios usan variables o archivos que crean los anteriores.\n\n"
        "Los ejemplos que dan error a propósito quedaron sólo en el manual."
    )
    if url_manual:
        intro += f" Las explicaciones están en [el manual]({url_manual})."
    celdas = [{"cell_type": "markdown", "metadata": {}, "source": _lineas(intro)}]

    # Un título se escribe recién cuando le sigue un ejemplo: los temas que son
    # sólo texto no dejan encabezados sueltos en el notebook.
    parte, tema = None, None
    for m in _ELEMENTO.finditer(fuente):
        if m.group("nivel"):
            titulo = html.unescape(_MARCADO.sub("", m.group("titulo"))).strip()
            if m.group("nivel") == "2":
                parte, tema = titulo, None
            else:
                tema = titulo
            continue
        if m.group("macro") != "py":
            continue
        if not _ejecutable(_opciones(m.group("opciones"))):
            continue
        encabezado = []
        if parte:
            encabezado.append(f"## {parte}")
            parte = None
        if tema:
            encabezado.append(f"### {tema}")
            tema = None
        if encabezado:
            celdas.append({"cell_type": "markdown", "metadata": {}, "source": _lineas("\n\n".join(encabezado))})
        celdas.append({
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": _lineas(m.group("cuerpo").strip()),
        })

    for numero, celda in enumerate(celdas, start=1):
        celda["id"] = f"manual-{numero:03d}"

    documento = {
        "cells": celdas,
        "metadata": {
            "kernelspec": {"display_name": "Python (ChartPython)", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.12", "mimetype": "text/x-python", "file_extension": ".py"},
            "chartbay": {"app": "chartpython", "name": "Manual de ChartPython"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    return json.dumps(documento, ensure_ascii=False, indent=1) + "\n"
