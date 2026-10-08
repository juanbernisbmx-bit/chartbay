"""La copia pública de lo aprobado, desde la terminal (ver `exportacion.py`).

    python -m servicio_datos.exportar --destino DIR             # exporta los releases publicados que falten y rehace el catálogo
    python -m servicio_datos.exportar comprobar --destino DIR   # verifica una copia, sin la base

Se configura por entorno:

    DATOS_EXPORTACION_DATABASE_URL   un rol que pueda leer lo publicado (sirve el de los respaldos, datos_respaldo)

Sale con código 1 si algo quedó pendiente o no coincide, para que quien lo programe se entere.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg

from servicio_datos import exportacion


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="La copia pública de lo aprobado.")
    parser.add_argument("comando", nargs="?", choices=["exportar", "comprobar"], default="exportar")
    parser.add_argument("--destino", required=True, help="La carpeta de la copia (por ejemplo, el repositorio donde se publica)")
    args = parser.parse_args(argv)
    destino = Path(args.destino)

    if args.comando == "comprobar":
        errores = exportacion.comprobar(destino)
        for error in errores:
            print(f"Error: {error}", file=sys.stderr)
        print(json.dumps({"errores": len(errores)}, ensure_ascii=False))
        return 1 if errores else 0

    url = (os.environ.get("DATOS_EXPORTACION_DATABASE_URL") or "").strip()
    if not url:
        print("Falta DATOS_EXPORTACION_DATABASE_URL: un rol que pueda leer lo publicado (sirve el de los respaldos)", file=sys.stderr)
        return 1
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            resultado = exportacion.exportar(conn, destino)
    except (psycopg.Error, OSError) as error:
        print(f"Error: no se pudo exportar ({type(error).__name__}: {error})", file=sys.stderr)
        return 1
    for pendiente in resultado["pendientes"]:
        print(f"Pendiente: {pendiente['release_id']}: {pendiente['motivo']}", file=sys.stderr)
    for error in resultado["errores"]:
        print(f"Error: {error}", file=sys.stderr)
    print(json.dumps(resultado, ensure_ascii=False))
    return 1 if (resultado["pendientes"] or resultado["errores"]) else 0


if __name__ == "__main__":
    sys.exit(main())
