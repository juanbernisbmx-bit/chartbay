"""Respaldo de la base y del crudo desde la terminal.

    python -m servicio_datos.respaldar                    # respalda base y crudo, ensaya si hay dónde y poda (apto para un cron)
    python -m servicio_datos.respaldar estado             # los últimos respaldos y qué hay guardado
    python -m servicio_datos.respaldar ensayar            # restaura el último volcado en la base de ensayo y compara
    python -m servicio_datos.respaldar restaurar-crudo    # devuelve al crudo, desde la copia, lo que falte o esté dañado
    python -m servicio_datos.respaldar sql-del-rol        # el SQL para crear el rol de solo lectura del respaldo (sin clave)
    python -m servicio_datos.respaldar empaquetar --salida DIR   # el último volcado y el crudo en un solo archivo, para guardarlo afuera

Se configura por entorno:

    DATOS_RESPALDO_DIR            dónde se guarda todo (base/ y crudo/). En OTRO disco que el crudo
    DATOS_RESPALDO_DATABASE_URL   un rol que pueda leer todo el esquema (pg_dump); no hace falta que escriba
    DATOS_DATABASE_URL            el del servicio: para anotar cada respaldo y saber qué archivos del crudo nombra la base
    DATOS_CRUDO_DIR               la carpeta del crudo
    DATOS_RESPALDO_DIAS           cuántos días se conservan todos los volcados (30); de los más viejos, uno por mes
    DATOS_RESPALDO_ENSAYO_URL     base local, vacía y dedicada, donde ensayar la restauración (opcional, recomendado)
    DATOS_PG_BIN                  carpeta de pg_dump y pg_restore, si no son los del PATH
    DATOS_CRUDO_DESCARGADO        1 si DATOS_CRUDO_DIR es una descarga recién hecha del bucket (el flujo de GitHub Actions)
    DATOS_RESPALDO_AGE_DESTINATARIO  para empaquetar: la clave pública de age (age1...) con la que se cifra el paquete

Cada respaldo queda anotado en la tabla `respaldo`; de ahí salen los avisos si falla o deja de correr.
Sale con código 1 si algo falló, para que el cron lo marque.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from servicio_datos import respaldo


def _registrar(url: str, inicio: datetime, ok: bool, resumen: dict) -> None:
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("INSERT INTO respaldo (iniciado_en, ok, error, detalle) VALUES (%s, %s, %s, %s)",
                     (inicio, ok, None if ok else "; ".join(resumen["errores"])[:2000] or "Falló sin detalle", Jsonb(resumen)))


def _hacer(conf: respaldo.Configuracion) -> int:
    inicio = datetime.now(timezone.utc)
    ok, resumen = respaldo.respaldar(conf, inicio)
    if conf.url_registro:
        try:
            _registrar(conf.url_registro, inicio, ok, resumen)
        except psycopg.Error as error:
            ok = False
            resumen["errores"].append(f"No se pudo anotar el respaldo en la base ({type(error).__name__}): los avisos no se van a enterar de esta corrida")
    else:
        ok = False
        resumen["errores"].append("Falta DATOS_DATABASE_URL: el respaldo no queda anotado y los avisos no se enteran si falla")
    for linea in resumen["avisos"]:
        print(f"Aviso: {linea}", file=sys.stderr)
    for linea in resumen["errores"]:
        print(f"Error: {linea}", file=sys.stderr)
    print(json.dumps(resumen, ensure_ascii=False))
    return 0 if ok else 1


def _estado(conf: respaldo.Configuracion) -> int:
    ahora = datetime.now(timezone.utc)
    if not conf.destino.is_dir():
        print(f"No existe {conf.destino}: ¿está montado el disco de respaldo?")
    completos = respaldo.volcados(conf.destino / "base")
    if completos:
        momento, ultimo = completos[-1]
        print(f"Último volcado: {ultimo.name}, hace {(ahora - momento).total_seconds() / 3600:.0f} h ({len(completos)} guardados)")
    else:
        print("Todavía no hay ningún volcado de la base.")
    copias = len(respaldo.archivos_de_crudo(conf.destino / "crudo"))
    originales = len(respaldo.archivos_de_crudo(conf.crudo)) if conf.crudo else 0
    print(f"Crudo: {copias} archivos en la copia, {originales} en el original.")
    if conf.destino.exists():
        libre = shutil.disk_usage(conf.destino).free
        print(f"Espacio libre en el destino: {libre / 2**30:.1f} GB")
    if conf.url_registro:
        with psycopg.connect(conf.url_registro, autocommit=True) as conn, conn.cursor(row_factory=dict_row) as cursor:
            cursor.execute("SELECT id, iniciado_en, ok, error FROM respaldo ORDER BY id DESC LIMIT 10")
            filas = cursor.fetchall()
        for f in filas:
            print(f"[{f['id']}] {f['iniciado_en']:%Y-%m-%d %H:%M} · {'ok' if f['ok'] else 'FALLÓ: ' + (f['error'] or '')[:160]}")
        if not filas:
            print("La base todavía no tiene ningún respaldo anotado.")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Respaldo de la base y del crudo.")
    parser.add_argument("comando", nargs="?", choices=["hacer", "estado", "ensayar", "restaurar-crudo", "sql-del-rol", "empaquetar"], default="hacer")
    parser.add_argument("--esquema", default="economia", help="Para sql-del-rol: el esquema del servicio (economia en Supabase)")
    parser.add_argument("--salida", help="Para empaquetar: la carpeta donde queda el paquete")
    args = parser.parse_args(argv)
    if args.comando == "empaquetar" and not args.salida:
        parser.error("empaquetar necesita --salida: la carpeta donde queda el paquete")
    if args.comando == "sql-del-rol":  # no necesita ninguna configuración: es texto para el administrador
        print(respaldo.sql_del_rol(esquema=args.esquema), end="")
        return 0
    try:
        conf = respaldo.configuracion_desde_entorno(os.environ)
    except ValueError as error:
        print(f"Error de configuración: {error}", file=sys.stderr)
        return 1

    if args.comando == "hacer":
        return _hacer(conf)
    if args.comando == "estado":
        return _estado(conf)
    try:
        if args.comando == "empaquetar":
            destinatario = (os.environ.get("DATOS_RESPALDO_AGE_DESTINATARIO") or "").strip() or None
            resultado = respaldo.empaquetar(conf.destino, Path(args.salida), datetime.now(timezone.utc), destinatario_age=destinatario)
            if not destinatario:
                print("Aviso: el paquete no va cifrado (no hay DATOS_RESPALDO_AGE_DESTINATARIO)", file=sys.stderr)
            print(json.dumps(resultado, ensure_ascii=False))
            return 0
        if args.comando == "ensayar":
            if not conf.url_ensayo:
                print("Falta DATOS_RESPALDO_ENSAYO_URL: una base local, vacía y dedicada al ensayo.", file=sys.stderr)
                return 1
            completos = respaldo.volcados(conf.destino / "base")
            if not completos:
                print("No hay ningún volcado para ensayar.", file=sys.stderr)
                return 1
            print(json.dumps(respaldo.ensayar(conf.url_ensayo, completos[-1][1], url_produccion=conf.url_registro, pg_bin=conf.pg_bin), ensure_ascii=False))
            return 0
        if conf.crudo is None:
            print("Falta DATOS_CRUDO_DIR: la carpeta del crudo a la que se restaura.", file=sys.stderr)
            return 1
        resultado = respaldo.restaurar_crudo(conf.destino / "crudo", conf.crudo)
        print(json.dumps(resultado, ensure_ascii=False))
        return 1 if resultado["danados_en_la_copia"] else 0
    except (respaldo.ErrorRespaldo, psycopg.Error, OSError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
