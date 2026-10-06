"""Línea de comandos del colector: `python -m servicio_datos.colectar ipc`.

Código de salida 0 si la corrida terminó bien (haya o no datos nuevos) y 1 si
falló, para que el cron o el servicio de tareas dispare la alerta.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg

from servicio_datos.cliente_http import ClienteHttp
from servicio_datos.colector import colectar
from servicio_datos.crudo import AlmacenCrudo


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Descarga y registra los archivos de una fuente.")
    parser.add_argument("fuente", choices=["ipc"])
    parser.add_argument("--url", default=os.environ.get("DATOS_DATABASE_URL"), help="URL de PostgreSQL (DATOS_DATABASE_URL)")
    parser.add_argument("--crudo", default=os.environ.get("DATOS_CRUDO_DIR"), help="Carpeta del crudo (DATOS_CRUDO_DIR)")
    parser.add_argument("--hoy", type=date.fromisoformat, help="Fecha en AAAA-MM-DD; por defecto, hoy en UTC")
    args = parser.parse_args(argv)
    if not args.url or not args.crudo:
        parser.error("Faltan --url y --crudo (o DATOS_DATABASE_URL y DATOS_CRUDO_DIR)")

    hoy = args.hoy or datetime.now(timezone.utc).date()
    with psycopg.connect(args.url, autocommit=True) as conn:
        resultado = colectar(conn, AlmacenCrudo(Path(args.crudo)), ClienteHttp(), hoy)
    print(json.dumps({
        "corrida": resultado.corrida_id,
        "estado": resultado.estado,
        "error": resultado.error,
        "archivos": [{"clave": d.clave, "url": d.url, "estado": d.estado, "sha256": d.sha256[:12]} for d in resultado.descargas],
    }, ensure_ascii=False))
    return 1 if resultado.estado == "fallida" else 0


if __name__ == "__main__":
    sys.exit(main())
