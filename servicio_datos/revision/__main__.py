"""Línea de comandos de la interfaz de revisión.

    python -m servicio_datos.revision clave juani      # genera la línea de DATOS_REVISORES para un usuario
    python -m servicio_datos.revision servir           # la sirve en 127.0.0.1 para probar

En producción se sirve con un servidor de verdad, siempre detrás de HTTPS:

    gunicorn "servicio_datos.revision.__main__:app_desde_entorno()" --bind 0.0.0.0:$PORT
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys

from werkzeug.security import generate_password_hash

from servicio_datos.revision.app import crear_app


def revisores_desde_entorno(valor: str | None) -> dict[str, str]:
    """`DATOS_REVISORES`: `usuario=hash` separados por `;` (los hashes de werkzeug no llevan `;` ni `=` al principio)."""
    revisores: dict[str, str] = {}
    for entrada in (valor or "").split(";"):
        if entrada.strip():
            usuario, separador, hash_clave = entrada.strip().partition("=")
            if not separador or not usuario or not hash_clave:
                raise ValueError("DATOS_REVISORES tiene que ser usuario=hash, con varios separados por ;")
            revisores[usuario] = hash_clave
    return revisores


def app_desde_entorno():
    url = os.environ.get("DATOS_DATABASE_URL")
    if not url:
        raise SystemExit("Falta DATOS_DATABASE_URL")
    return crear_app(url, revisores_desde_entorno(os.environ.get("DATOS_REVISORES")))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Interfaz de revisión de candidatos.")
    comandos = parser.add_subparsers(dest="comando", required=True)
    clave = comandos.add_parser("clave", help="genera el hash de contraseña de un revisor")
    clave.add_argument("usuario")
    servir = comandos.add_parser("servir", help="sirve la interfaz para probarla")
    servir.add_argument("--puerto", type=int, default=5080)
    args = parser.parse_args(argv)

    if args.comando == "clave":
        if not args.usuario.isidentifier():
            parser.error("El usuario tiene que ser una palabra sin espacios ni símbolos")
        primera = getpass.getpass("Contraseña: ")
        if len(primera) < 12:
            print("Usá al menos 12 caracteres.", file=sys.stderr)
            return 1
        if primera != getpass.getpass("Repetila: "):
            print("No coinciden.", file=sys.stderr)
            return 1
        print(f"{args.usuario}={generate_password_hash(primera)}")
        print("\nAgregá esa línea a DATOS_REVISORES (varias, separadas por ;).", file=sys.stderr)
        return 0

    # Solo en este equipo: para exponerla hay que usar un servidor de verdad, con HTTPS.
    app_desde_entorno().run(host="127.0.0.1", port=args.puerto, debug=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
