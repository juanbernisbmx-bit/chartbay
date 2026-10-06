"""Avisos por Slack o correo desde la terminal.

    python -m servicio_datos.avisar            # detecta lo que haya y lo entrega (apto para un cron)
    python -m servicio_datos.avisar estado     # los últimos avisos y cómo les fue
    python -m servicio_datos.avisar probar     # manda un mensaje de prueba por cada canal configurado

Los canales se configuran por entorno; sin ninguno, no hace nada:

    DATOS_AVISOS_SLACK_URL        webhook de Slack (https://hooks.slack.com/...); es una credencial
    DATOS_AVISOS_SMTP_HOST        servidor de correo; con DATOS_AVISOS_SMTP_PUERTO (587), _USUARIO, _CLAVE
    DATOS_AVISOS_SMTP_SEGURIDAD   starttls (por defecto), ssl o ninguna (solo para un servidor local)
    DATOS_AVISOS_DE / _PARA       remitente y destinatarios (separados por coma)
    DATOS_REVISION_URL            dirección de la interfaz de revisión, para los enlaces

Sale con código 1 si alguna entrega falló, para que el cron lo marque.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, datetime, timezone

import psycopg
from psycopg.rows import dict_row

from servicio_datos import avisos
from servicio_datos.canales import ErrorEnvio, Mensaje, configuracion_desde_entorno


def resumen(resultado: avisos.Resultado) -> dict:
    return {"creados": resultado.creados, "enviados": resultado.enviados, "descartados": resultado.descartados,
            "pendientes": resultado.pendientes, "fallidos": resultado.fallidos, "ocupado": resultado.ocupado, "errores": list(resultado.errores)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Avisos por Slack o correo.")
    parser.add_argument("comando", nargs="?", choices=["procesar", "estado", "probar"], default="procesar")
    parser.add_argument("--url", default=os.environ.get("DATOS_DATABASE_URL"), help="URL de PostgreSQL (DATOS_DATABASE_URL)")
    parser.add_argument("--hoy", type=date.fromisoformat, help="Fecha en AAAA-MM-DD; por defecto, hoy en UTC")
    args = parser.parse_args(argv)
    configuracion = None
    if args.comando != "estado":  # consultar el estado no usa los canales: no depende de que estén bien configurados
        try:
            configuracion = configuracion_desde_entorno(os.environ)
        except ValueError as error:  # el mensaje no trae secretos: ver canales.py
            print(f"Error de configuración: {error}", file=sys.stderr)
            return 1

    if args.comando == "probar":
        if not configuracion.canales:
            print("No hay ningún canal configurado.", file=sys.stderr)
            return 1
        fallo = False
        for canal in configuracion.canales:
            try:
                canal.enviar(Mensaje("Prueba de avisos de ChartBay", "Si ves este mensaje, el canal está bien configurado.", configuracion.url_base))
                print(f"{canal.nombre}: ok")
            except ErrorEnvio as error:
                print(f"{canal.nombre}: {error}", file=sys.stderr)
                fallo = True
        return 1 if fallo else 0

    if not args.url:
        parser.error("Falta la URL: usá --url o la variable DATOS_DATABASE_URL")
    with psycopg.connect(args.url, autocommit=True) as conn:
        if args.comando == "estado":
            with conn.cursor(row_factory=dict_row) as cursor:
                cursor.execute("SELECT id, tipo, estado, intentos, creado_en, entregas FROM aviso ORDER BY id DESC LIMIT 20")
                for a in cursor.fetchall():
                    canales = ", ".join(f"{n}={'ok' if e.get('ok') else 'falló'}" for n, e in a["entregas"].items()) or "sin intentos"
                    print(f"[{a['id']}] {a['tipo']} · {a['estado']} · {a['intentos']} intentos · {a['creado_en']:%Y-%m-%d %H:%M} · {canales}")
            return 0
        resultado = avisos.procesar(conn, configuracion.canales, configuracion.url_base, args.hoy or datetime.now(timezone.utc).date())
    if not configuracion.canales:
        print("No hay ningún canal configurado: no se avisa nada.", file=sys.stderr)
    print(json.dumps(resumen(resultado), ensure_ascii=False))
    return 1 if (resultado.errores or resultado.fallidos) else 0


if __name__ == "__main__":
    sys.exit(main())
