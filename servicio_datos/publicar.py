"""Revisión de candidatos desde la terminal, hasta que exista la interfaz.

    python -m servicio_datos.publicar estado 1
    python -m servicio_datos.publicar aceptar 1 --por juani --comentario "Revisado: es la devaluación"
    python -m servicio_datos.publicar rechazar 1 --hallazgo 4 --por juani --comentario "Parece un error de carga"
    python -m servicio_datos.publicar publicar 1 --por juani
    python -m servicio_datos.publicar descartar 1 --por juani --motivo "El nacional está mal cargado"

Sale con código 1 si la operación no se pudo hacer (y dice por qué), 0 si salió bien.
"""
from __future__ import annotations

import argparse
import os
import sys

import psycopg

from servicio_datos import publicacion
from servicio_datos.publicacion import ErrorPublicacion


def _hallazgos(conn: psycopg.Connection, candidato_id: int) -> list[tuple]:
    return conn.execute(
        "SELECT h.id, h.regla, h.severidad, h.serie_id, h.periodo, h.detalle, u.decision, u.revisor "
        "FROM candidato c JOIN hallazgo h ON h.corrida_id = c.corrida_id "
        "LEFT JOIN LATERAL (SELECT decision, revisor FROM revision_hallazgo r WHERE r.hallazgo_id = h.id "
        " ORDER BY r.id DESC LIMIT 1) u ON true WHERE c.id = %s ORDER BY h.id",
        (candidato_id,),
    ).fetchall()


def _estado(conn: psycopg.Connection, candidato_id: int) -> None:
    fila = conn.execute("SELECT estado, motivo FROM candidato WHERE id = %s", (candidato_id,)).fetchone()
    if fila is None:
        raise ErrorPublicacion("no_existe", f"No existe el candidato {candidato_id}")
    revision = publicacion.estado_revision(conn, candidato_id)
    print(f"Candidato {candidato_id}: {fila[0]}" + (f" ({fila[1]})" if fila[1] else ""))
    print(f"Hallazgos: {revision.total}, aceptados {revision.aceptados}, rechazados {revision.rechazados}, "
          f"sin resolver {revision.pendientes}. Propuestas sin decidir: {revision.propuestas_pendientes}")
    for hallazgo_id, regla, severidad, serie_id, periodo, detalle, decision, revisor in _hallazgos(conn, candidato_id):
        marca = f"{decision} por {revisor}" if decision else "SIN RESOLVER"
        donde = " ".join(str(x) for x in (serie_id, periodo) if x)
        print(f"  [{hallazgo_id}] {severidad:5} {regla} {donde}: {detalle} -> {marca}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Revisa, publica o descarta un candidato.")
    parser.add_argument("--url", default=os.environ.get("DATOS_DATABASE_URL"), help="URL de PostgreSQL (DATOS_DATABASE_URL)")
    comandos = parser.add_subparsers(dest="comando", required=True)
    for nombre in ("estado", "aceptar", "rechazar", "publicar", "descartar"):
        comando = comandos.add_parser(nombre)
        comando.add_argument("candidato", type=int)
        if nombre != "estado":
            comando.add_argument("--por", required=True, help="Quién lo hace")
        if nombre in ("aceptar", "rechazar"):
            comando.add_argument("--hallazgo", type=int, action="append", help="Id del hallazgo; se puede repetir")
            comando.add_argument("--comentario", required=True)
        if nombre == "descartar":
            comando.add_argument("--motivo", required=True)
    args = parser.parse_args(argv)
    if not args.url:
        parser.error("Falta la URL: usá --url o la variable DATOS_DATABASE_URL")

    with psycopg.connect(args.url, autocommit=True) as conn:
        try:
            if args.comando == "estado":
                _estado(conn, args.candidato)
            elif args.comando in ("aceptar", "rechazar"):
                decision = "aceptado" if args.comando == "aceptar" else "rechazado"
                hallazgos = _hallazgos(conn, args.candidato)
                if not hallazgos:
                    raise ErrorPublicacion("sin_hallazgos", f"El candidato {args.candidato} no tiene hallazgos")
                if args.hallazgo:
                    ids = args.hallazgo
                    ajenos = set(ids) - {h[0] for h in hallazgos}
                    if ajenos:
                        raise ErrorPublicacion("revision_invalida", f"Hallazgos que no son de este candidato: {sorted(ajenos)}")
                elif decision == "rechazado":
                    raise ErrorPublicacion("revision_invalida", "Para rechazar hay que indicar el hallazgo con --hallazgo")
                else:
                    ids = [h[0] for h in hallazgos if h[6] is None]  # sin --hallazgo: todos los que faltan
                with conn.transaction():  # todos o ninguno
                    for hallazgo_id in ids:
                        publicacion.revisar_hallazgo(conn, hallazgo_id, decision, args.por, args.comentario)
                print(f"{len(ids)} hallazgo(s) {decision}(s) por {args.por}")
            elif args.comando == "publicar":
                p = publicacion.publicar_candidato(conn, args.candidato, args.por)
                print(f"Publicado {p.release_id} (release {p.release_numero}): {p.observaciones_abiertas} versiones nuevas, "
                      f"{p.observaciones_cerradas} cerradas, {p.observaciones_sin_cambio} sin cambios. Hash {p.hash_contenido[:12]}")
            else:
                publicacion.descartar_candidato(conn, args.candidato, args.por, args.motivo)
                print(f"Candidato {args.candidato} descartado por {args.por}")
        except ErrorPublicacion as error:
            print(f"Error: {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
