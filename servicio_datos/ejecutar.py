"""Línea de comandos del pipeline: `python -m servicio_datos.ejecutar ipc`.

Hace la corrida completa (colecta, parseo, validación y candidato). Sale con
código 1 si la corrida falló, para que el cron o el servicio de tareas dispare
la alerta; `colectar.py` hace solo la descarga.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg

from servicio_datos import avisos
from servicio_datos.canales import configuracion_desde_entorno
from servicio_datos.cliente_http import ClienteHttp
from servicio_datos.crudo import AlmacenCrudo
from servicio_datos.pipeline import correr_ipc


def _avisar(conn: psycopg.Connection, hoy: date) -> dict | None:
    """Detecta y entrega avisos tras la corrida. Si fallan, la corrida no cambia: se dice y se sigue."""
    try:
        configuracion = configuracion_desde_entorno(os.environ)
        if not configuracion.canales:
            return None
        resultado = avisos.procesar(conn, configuracion.canales, configuracion.url_base, hoy)
        return {"creados": resultado.creados, "enviados": resultado.enviados, "pendientes": resultado.pendientes, "errores": list(resultado.errores)}
    except Exception as error:  # los avisos son un agregado: nunca pueden romper ni ocultar el resultado de la corrida
        print(f"No se pudieron procesar los avisos ({type(error).__name__}).", file=sys.stderr)
        return {"error": type(error).__name__}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Corre el pipeline de una fuente hasta dejar un candidato.")
    parser.add_argument("fuente", choices=["ipc"])
    parser.add_argument("--url", default=os.environ.get("DATOS_DATABASE_URL"), help="URL de PostgreSQL (DATOS_DATABASE_URL)")
    parser.add_argument("--crudo", default=os.environ.get("DATOS_CRUDO_DIR"), help="Carpeta del crudo (DATOS_CRUDO_DIR)")
    parser.add_argument("--hoy", type=date.fromisoformat, help="Fecha en AAAA-MM-DD; por defecto, hoy en UTC")
    args = parser.parse_args(argv)
    if not args.url or not args.crudo:
        parser.error("Faltan --url y --crudo (o DATOS_DATABASE_URL y DATOS_CRUDO_DIR)")

    hoy = args.hoy or datetime.now(timezone.utc).date()
    with psycopg.connect(args.url, autocommit=True) as conn:
        resultado = correr_ipc(conn, AlmacenCrudo(Path(args.crudo)), ClienteHttp(), hoy)
        informe_avisos = _avisar(conn, hoy)
    por_regla: dict[str, int] = {}
    for hallazgo in resultado.hallazgos:
        clave = f"{hallazgo.regla}:{hallazgo.severidad}"
        por_regla[clave] = por_regla.get(clave, 0) + 1
    print(json.dumps({
        "corrida": resultado.corrida_id, "estado": resultado.estado, "candidato": resultado.candidato_id,
        "hallazgos": por_regla, "error": resultado.error, "avisos": informe_avisos,
    }, ensure_ascii=False))
    return 1 if resultado.estado == "fallida" else 0


if __name__ == "__main__":
    sys.exit(main())
