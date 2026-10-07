"""El latido hacia el monitor externo, desde la terminal (ver `monitor.py`).

    python -m servicio_datos.latido            # comprueba todo y le late al monitor (cron, cada 10 minutos)
    python -m servicio_datos.latido estado     # comprueba todo y lo muestra, sin latir
    python -m servicio_datos.latido probar     # manda un latido de prueba, para ver que el monitor lo recibe

Se configura por entorno:

    DATOS_MONITOR_URL           la dirección de latido del servicio externo (Healthchecks.io: https://hc-ping.com/...). Es una
                                credencial: quien la tenga puede hacerse pasar por el equipo
    DATOS_MONITOR_SALUD_LOCAL   dónde responde /salud el servicio de revisión en el equipo (http://127.0.0.1:8000/salud)

y usa los de siempre: DATOS_DATABASE_URL, DATOS_REVISION_URL, DATOS_RUN_DIR, DATOS_CRUDO_DIR, DATOS_RESPALDO_DIR y los de avisos.
Sale con código 1 si algo falla o si no pudo latir.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

from servicio_datos import monitor


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Latido hacia el monitor externo.")
    parser.add_argument("comando", nargs="?", choices=["latir", "estado", "probar"], default="latir")
    args = parser.parse_args(argv)
    conf = monitor.configuracion_desde_entorno(os.environ)

    latidor = None
    if args.comando != "estado":
        if not conf.url_monitor:
            print("Error de configuración: falta DATOS_MONITOR_URL, la dirección de latido del monitor externo.", file=sys.stderr)
            return 1
        try:
            latidor = monitor.Monitor(conf.url_monitor)
        except ValueError as error:
            print(f"Error de configuración: {error}", file=sys.stderr)
            return 1

    if args.comando == "probar":
        try:
            latidor.latir("ChartBay datos: latido de prueba. Si lo ves en el monitor, el equipo llega.")
        except monitor.ErrorLatido as error:
            print(f"No se pudo latir: {error}", file=sys.stderr)
            return 1
        print("El monitor recibió el latido de prueba.")
        return 0

    sano, texto = monitor.resumen(monitor.comprobar(conf, datetime.now(timezone.utc)))
    if args.comando == "estado":
        print(texto)
        return 0 if sano else 1
    try:
        latidor.latir(texto, falla=not sano)
    except monitor.ErrorLatido as error:
        print(texto)
        print(f"No se pudo latir: {error}. Si sigue así, el monitor va a avisar que el equipo no responde.", file=sys.stderr)
        return 1
    # Con todo bien alcanza una línea por latido (son 144 por día); con algo mal, el detalle entero.
    print(texto if not sano or "advertencia" in texto.splitlines()[0] else texto.splitlines()[0])
    return 0 if sano else 1


if __name__ == "__main__":
    sys.exit(main())
