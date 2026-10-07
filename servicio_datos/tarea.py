"""Lanzador de las tareas programadas (cron): `python -m servicio_datos.tarea ejecutar`, `avisar`, `agente`, `respaldar` o `latido`.

Cron arranca los procesos con un entorno casi vacío y no sabe si la corrida anterior sigue andando. Esto
resuelve lo que cron no hace, sin tocar las tareas en sí:

- **Carga el archivo de secretos** (`--entorno`, formato `CLAVE=valor` como el `EnvironmentFile` de systemd) y se
  niega a usarlo si lo puede leer otro usuario del equipo o no es del usuario que corre la tarea.
  No se ejecuta nada del archivo: no es un script de shell, solo pares clave-valor.
- **Evita que dos corridas de la misma tarea se pisen**: si la anterior sigue, esta se omite (y no es un error).
- **Corta una corrida colgada** pasado un límite, matando también a sus procesos hijos.
- **Deja una línea de registro** por corrida con el código de salida y cuánto tardó.
- **Deja el estado de la última corrida** de cada tarea en `DATOS_RUN_DIR` (`chartbay-datos-<tarea>.estado.json`: cuándo terminó,
  con qué código y cuántas veces seguidas viene fallando). Es lo que mira el latido para saber si cron sigue corriendo cada tarea,
  sin depender de la base. Solo cuenta la forma programada: `tarea respaldar estado` o `tarea avisar probar` (con un subcomando)
  no lo actualizan, para que una consulta a mano no haga parecer al día una tarea cuyo cron está muerto.

Lo que se escribe después del nombre de la tarea se le pasa tal cual (`tarea avisar probar`, `tarea ejecutar --hoy 2026-10-06`).

Códigos de salida: el de la tarea; 0 si se omitió porque ya había una corriendo; 124 si pasó el límite; 2 si no
se pudo arrancar (entorno ilegible o con permisos abiertos, tarea desconocida).
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Sequence

TAREAS: Mapping[str, Sequence[str]] = {
    "ejecutar": (sys.executable, "-m", "servicio_datos.ejecutar", "ipc"),
    "avisar": (sys.executable, "-m", "servicio_datos.avisar"),
    "agente": (sys.executable, "-m", "servicio_datos.agente"),
    "respaldar": (sys.executable, "-m", "servicio_datos.respaldar"),
    "latido": (sys.executable, "-m", "servicio_datos.latido"),
}
LIMITE_SEGUNDOS = 20 * 60
NOMBRE_VALIDO = re.compile(r"^[A-Z_][A-Z0-9_]*$")


class ErrorTarea(Exception):
    pass


def leer_entorno(ruta: Path) -> dict[str, str]:
    """Pares `CLAVE=valor` de un archivo de secretos. Rechaza uno que no sea solo del usuario que corre la tarea."""
    try:
        info = ruta.stat()
    except OSError:
        raise ErrorTarea(f"No se pudo leer el archivo de entorno {ruta}") from None
    if info.st_uid != os.geteuid():
        raise ErrorTarea(f"El archivo de entorno {ruta} tiene que ser del usuario que corre la tarea")
    if info.st_mode & 0o077:
        raise ErrorTarea(f"El archivo de entorno {ruta} lo puede leer otro usuario: corré chmod 600 {ruta}")
    variables: dict[str, str] = {}
    for numero, linea in enumerate(ruta.read_text(encoding="utf-8").splitlines(), 1):
        linea = linea.strip()
        if not linea or linea.startswith("#"):
            continue
        nombre, separador, valor = linea.partition("=")
        nombre = nombre.strip()
        if not separador or not NOMBRE_VALIDO.match(nombre):
            # No se repite el contenido de la línea: puede ser un secreto.
            raise ErrorTarea(f"{ruta}, línea {numero}: tiene que ser CLAVE=valor")
        valor = valor.strip()
        if len(valor) >= 2 and valor[0] == valor[-1] and valor[0] in "'\"":
            valor = valor[1:-1]
        variables[nombre] = valor
    return variables


def _ahora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def ruta_estado(carpeta: Path, nombre: str) -> Path:
    return carpeta / f"chartbay-datos-{nombre}.estado.json"


def _guardar_estado(carpeta: Path, nombre: str, registro: dict) -> None:
    """El resultado de la corrida, con la cuenta de fallas seguidas. No puede cambiar el código de salida de la tarea."""
    ruta = ruta_estado(carpeta, nombre)
    try:
        previas = int(json.loads(ruta.read_text(encoding="utf-8")).get("fallas_seguidas", 0))
    except (OSError, ValueError, TypeError, AttributeError):
        previas = 0
    contenido = {**registro, "fallas_seguidas": 0 if registro["codigo"] == 0 else previas + 1}
    temporal = ruta.with_name(ruta.name + ".tmp")
    try:
        temporal.write_text(json.dumps(contenido), encoding="utf-8")
        os.replace(temporal, ruta)
    except OSError as error:
        print(f"No se pudo guardar el estado de la tarea {nombre}: {error}", file=sys.stderr, flush=True)


def ejecutar_tarea(
    nombre: str, comando: Sequence[str], entorno: Mapping[str, str] | None = None, limite: float = LIMITE_SEGUNDOS,
    carpeta_bloqueos: Path | None = None, registrar_estado: bool = True,
) -> int:
    carpeta = carpeta_bloqueos or Path(os.environ.get("DATOS_RUN_DIR") or tempfile.gettempdir())
    inicio, reloj = _ahora(), time.monotonic()
    with open(carpeta / f"chartbay-datos-{nombre}.lock", "a") as bloqueo:
        try:
            fcntl.flock(bloqueo, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({"tarea": nombre, "inicio": inicio, "omitida": "ya hay una corrida en curso"}), flush=True)
            return 0
        proceso = subprocess.Popen(list(comando), env={**os.environ, **(entorno or {})}, start_new_session=True)
        try:
            codigo = proceso.wait(timeout=limite)
        except subprocess.TimeoutExpired:
            os.killpg(proceso.pid, signal.SIGKILL)  # el grupo entero: la tarea y lo que haya lanzado
            proceso.wait()
            codigo = 124
            print(f"La tarea {nombre} superó el límite de {int(limite)} s y se cortó.", file=sys.stderr, flush=True)
        registro = {"tarea": nombre, "inicio": inicio, "fin": _ahora(), "codigo": codigo, "segundos": round(time.monotonic() - reloj, 1)}
        if registrar_estado:
            _guardar_estado(carpeta, nombre, registro)  # dentro del bloqueo: nadie más escribe el de esta tarea
    print(json.dumps(registro), flush=True)
    return codigo


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Corre una tarea programada del servicio de datos.")
    parser.add_argument("tarea", choices=sorted(TAREAS))
    parser.add_argument("argumentos", nargs=argparse.REMAINDER, help="Se le pasan a la tarea (por ejemplo: probar)")
    parser.add_argument("--entorno", type=Path, help="Archivo CLAVE=valor con los secretos (debe ser 0600 y del usuario que corre)")
    parser.add_argument("--limite", type=float, default=LIMITE_SEGUNDOS, help="Segundos antes de cortar la tarea (por defecto 1200)")
    args = parser.parse_args(argv)
    try:
        entorno = leer_entorno(args.entorno) if args.entorno else {}
    except ErrorTarea as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2
    programada = not (args.argumentos and not args.argumentos[0].startswith("-"))  # un subcomando es una consulta a mano
    return ejecutar_tarea(args.tarea, [*TAREAS[args.tarea], *args.argumentos], entorno, args.limite, registrar_estado=programada)


if __name__ == "__main__":
    sys.exit(main())
