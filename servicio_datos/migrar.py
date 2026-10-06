"""Aplica las migraciones SQL numeradas de `migraciones/` en orden.

Cada archivo corre en su propia transacción y queda registrado con su checksum
en `schema_migrations`. Una migración ya aplicada no se puede editar: si el
archivo cambió, el migrador se detiene en vez de dejar la base a medias.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from pathlib import Path

import psycopg

MIGRACIONES = Path(__file__).resolve().parent / "migraciones"
PATRON = re.compile(r"^(\d{4})_[a-z0-9_]+\.sql$")
CANDADO = 727274  # pg_advisory_lock: evita dos migradores a la vez


class ErrorMigracion(Exception):
    pass


def _leer(directorio: Path) -> list[tuple[str, str, str, str]]:
    """Devuelve (versión, nombre de archivo, SQL, checksum) en orden."""
    encontradas = []
    for ruta in sorted(directorio.glob("*.sql")):
        coincide = PATRON.match(ruta.name)
        if not coincide:
            raise ErrorMigracion(f"Nombre de migración inválido: {ruta.name}")
        sql = ruta.read_text(encoding="utf-8")
        checksum = hashlib.sha256(sql.encode("utf-8")).hexdigest()
        encontradas.append((coincide.group(1), ruta.name, sql, checksum))
    versiones = [v for v, *_ in encontradas]
    if len(set(versiones)) != len(versiones):
        raise ErrorMigracion("Hay dos migraciones con el mismo número")
    return encontradas


def aplicar(conn: psycopg.Connection, directorio: Path = MIGRACIONES) -> list[str]:
    """Aplica las migraciones pendientes y devuelve las versiones aplicadas."""
    migraciones = _leer(directorio)
    aplicadas_ahora: list[str] = []
    conn.execute("SELECT pg_advisory_lock(%s)", (CANDADO,))
    try:
        with conn.transaction():
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                " version text PRIMARY KEY, nombre text NOT NULL,"
                " checksum text NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now())"
            )
        registradas = {
            v: c for v, c in conn.execute("SELECT version, checksum FROM schema_migrations")
        }
        for version, nombre, sql, checksum in migraciones:
            if version in registradas:
                if registradas[version] != checksum:
                    raise ErrorMigracion(
                        f"La migración {nombre} ya estaba aplicada y su contenido cambió"
                    )
                continue
            with conn.transaction():
                conn.execute(sql)
                conn.execute(
                    "INSERT INTO schema_migrations (version, nombre, checksum) VALUES (%s, %s, %s)",
                    (version, nombre, checksum),
                )
            aplicadas_ahora.append(version)
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (CANDADO,))
    return aplicadas_ahora


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Aplica las migraciones de la base de datos.")
    parser.add_argument(
        "--url",
        default=os.environ.get("DATOS_DATABASE_URL"),
        help="URL de PostgreSQL; por defecto, la variable DATOS_DATABASE_URL",
    )
    args = parser.parse_args(argv)
    if not args.url:
        parser.error("Falta la URL: usá --url o la variable DATOS_DATABASE_URL")
    with psycopg.connect(args.url, autocommit=True) as conn:
        try:
            nuevas = aplicar(conn)
        except ErrorMigracion as error:
            print(f"Error: {error}", file=sys.stderr)
            return 1
    print("Migraciones aplicadas: " + (", ".join(nuevas) if nuevas else "ninguna, ya estaba al día"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
