"""Busca y exporta series importadas; abre SQLite en modo de solo lectura."""
import argparse
import csv
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATABASE = ROOT / "datos/base/economia.sqlite"


def connect(path: Path = DATABASE):
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def search(connection, text: str = "", catalog: str | None = None, limit: int = 20):
    query = "SELECT catalogo_id,serie_id,titulo,unidad,frecuencia,fuente,observaciones,inicio,fin FROM catalogo WHERE (titulo LIKE ? OR descripcion LIKE ? OR serie_id LIKE ?)"
    params = ["%" + text + "%"] * 3
    if catalog:
        query += " AND catalogo_id=?"
        params.append(catalog)
    query += " ORDER BY observaciones DESC,catalogo_id,serie_id LIMIT ?"
    params.append(limit)
    return [dict(row) for row in connection.execute(query, params)]


def export(connection, catalog: str, series_id: str, destination: Path):
    metadata = connection.execute("SELECT * FROM catalogo WHERE catalogo_id=? AND serie_id=?", (catalog, series_id)).fetchone()
    if metadata is None:
        raise ValueError("La serie no existe en ese catálogo")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["periodo", "valor", "frecuencia"])
        writer.writerows(connection.execute("""SELECT DISTINCT periodo,valor,frecuencia
            FROM observacion WHERE catalogo_id=? AND serie_id=? ORDER BY periodo,valor""", (catalog, series_id)))
    files = [dict(row) for row in connection.execute("""SELECT DISTINCT a.* FROM archivo a
        JOIN observacion o ON o.archivo_sha256=a.sha256 WHERE o.catalogo_id=? AND o.serie_id=?""", (catalog, series_id))]
    details = [json.loads(row[0]) for row in connection.execute("""SELECT detalle_json FROM descarga
        WHERE sha256 IN (SELECT archivo_sha256 FROM observacion WHERE catalogo_id=? AND serie_id=?)""", (catalog, series_id))]
    ficha = {"serie": dict(metadata), "archivos": files, "descargas": details,
             "nota": "Valores textuales originales. Cifras distintas del mismo período se exportan en filas separadas; no se elige una revisión."}
    destination.with_suffix(".ficha.json").write_text(json.dumps(ficha, ensure_ascii=False, indent=2) + "\n")
    return dict(metadata)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", type=Path, default=DATABASE)
    commands = parser.add_subparsers(dest="command", required=True)
    finding = commands.add_parser("buscar")
    finding.add_argument("texto", nargs="?", default="")
    finding.add_argument("--catalogo")
    finding.add_argument("--limite", type=int, default=20)
    exporting = commands.add_parser("exportar")
    exporting.add_argument("--catalogo", required=True)
    exporting.add_argument("--serie", required=True)
    exporting.add_argument("--salida", required=True, type=Path)
    args = parser.parse_args()
    connection = connect(args.base)
    try:
        if args.command == "buscar":
            print(json.dumps(search(connection, args.texto, args.catalogo, args.limite), ensure_ascii=False, indent=2))
        else:
            print(json.dumps(export(connection, args.catalogo, args.serie, args.salida), ensure_ascii=False, indent=2))
    finally:
        connection.close()
