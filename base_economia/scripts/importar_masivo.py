"""Importa descargas oficiales conservadas a SQLite, sin limpiar ni publicar datos."""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import io
import json
import re
import sqlite3
import zipfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / "datos/base"
MAX_UNCOMPRESSED = 512 * 1024 * 1024

SCHEMA = """
CREATE TABLE archivo(sha256 TEXT PRIMARY KEY, ruta TEXT, bytes INTEGER);
CREATE TABLE descarga(id INTEGER PRIMARY KEY, sha256 TEXT, url TEXT, estado TEXT, detalle_json TEXT);
CREATE TABLE serie(catalogo_id TEXT, serie_id TEXT, titulo TEXT, descripcion TEXT,
 unidad TEXT, frecuencia TEXT, fuente TEXT, dataset TEXT, url TEXT,
 metadatos_json TEXT, archivo_sha256 TEXT, fila_origen INTEGER,
 PRIMARY KEY(catalogo_id,serie_id));
CREATE TABLE observacion(catalogo_id TEXT, serie_id TEXT, periodo TEXT, valor TEXT,
 frecuencia TEXT, archivo_sha256 TEXT, fila_origen INTEGER);
CREATE TABLE metadato(catalogo_id TEXT,serie_id TEXT,archivo_sha256 TEXT,fila_origen INTEGER,
 datos_json TEXT,PRIMARY KEY(catalogo_id,serie_id,archivo_sha256));
CREATE TABLE fuente(numero INTEGER PRIMARY KEY, datos_json TEXT, archivo_sha256 TEXT);
CREATE TABLE recurso_csv(sha256 TEXT PRIMARY KEY, encabezados_json TEXT, codificacion TEXT,
 delimitador TEXT, filas INTEGER);
CREATE TABLE fila_csv(archivo_sha256 TEXT, numero INTEGER, celdas_json TEXT,
 PRIMARY KEY(archivo_sha256,numero));
CREATE TABLE importacion(clave TEXT PRIMARY KEY, valor_json TEXT);
"""


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def source_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT))
    except ValueError:
        return str(path.resolve())


def verified_file(manifest_path: Path, entry: dict) -> Path:
    filename = entry["file"]
    if not re.fullmatch(r"[0-9a-f]{64}\.(?:csv|zip|html|xlsx|xls|json|bin)", filename):
        raise ValueError("Nombre de original no válido")
    path = manifest_path.parent / filename
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != entry["sha256"] or path.stat().st_size != entry["bytes"]:
        raise ValueError("El original no coincide con su hash o tamaño: " + filename)
    return path


@contextmanager
def values_reader(path: Path):
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) != 1 or members[0].filename != "series-tiempo-valores.csv":
            raise ValueError("El ZIP no tiene el CSV de valores esperado")
        if members[0].file_size > MAX_UNCOMPRESSED:
            raise ValueError("El CSV descomprimido supera 512 MiB")
        with archive.open(members[0]) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            required = {"catalogo_id", "dataset_id", "distribucion_id", "serie_id",
                        "indice_tiempo", "valor", "indice_tiempo_frecuencia"}
            if set(reader.fieldnames or ()) != required:
                raise ValueError("Cambió la estructura del dump de valores")
            yield reader


def import_metadata(connection, path: Path, sha256: str) -> list[dict]:
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        required = {"catalogo_id", "serie_id", "serie_titulo", "serie_unidades",
                    "indice_tiempo_frecuencia", "serie_valores_cant"}
        if not required.issubset(reader.fieldnames or ()):
            raise ValueError("Cambió la estructura del dump de metadatos")
        rows = list(reader)
    connection.executemany("INSERT OR IGNORE INTO metadato VALUES(?,?,?,?,?)", [
        (row["catalogo_id"], row["serie_id"], sha256, n, encoded(row)) for n, row in enumerate(rows, 2)])
    connection.executemany("INSERT OR IGNORE INTO serie VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", [(
        row["catalogo_id"], row["serie_id"], row["serie_titulo"], row.get("serie_descripcion", ""),
        row["serie_unidades"], row["indice_tiempo_frecuencia"], row.get("dataset_fuente", ""),
        row.get("dataset_titulo", ""), row.get("distribucion_url_descarga", ""),
        encoded(row), sha256, number,
    ) for number, row in enumerate(rows, 2)])
    return rows


def import_values(connection, path: Path, entry: dict, skip_catalogs: set[str]) -> int:
    count, batch = 0, []
    with values_reader(path) as reader:
        for number, row in enumerate(reader, 2):
            if row["catalogo_id"] in skip_catalogs:
                continue
            if entry.get("catalogo_id") and row["catalogo_id"] != entry["catalogo_id"]:
                raise ValueError("El dump por catálogo contiene otro catálogo")
            batch.append((row["catalogo_id"], row["serie_id"], row["indice_tiempo"], row["valor"],
                          row["indice_tiempo_frecuencia"], entry["sha256"], number))
            count += 1
            if len(batch) >= 10000:
                connection.executemany("INSERT INTO observacion VALUES(?,?,?,?,?,?,?)", batch)
                batch.clear()
        connection.executemany("INSERT INTO observacion VALUES(?,?,?,?,?,?,?)", batch)
    return count


def import_distribution(connection, path: Path, entry: dict) -> dict:
    text, _, delimiter = csv_content(path)
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    headers = reader.fieldnames or []
    if "indice_tiempo" not in headers:
        return {"url": entry["url"], "observaciones": 0, "motivo": "No tiene columna indice_tiempo"}
    def normalize_url(url):
        parsed = urlsplit(url)
        host = parsed.hostname
        if host in ("www.economia.gob.ar", "www.mecon.gob.ar"):
            host = "ministerio_economia"
        return host, parsed.path
    wanted = normalize_url(entry["url"])
    mappings = []
    for catalog, series_id, title, frequency, url in connection.execute("SELECT catalogo_id,serie_id,titulo,frecuencia,url FROM serie"):
        if normalize_url(url) == wanted and headers.count(title) == 1:
            mappings.append((catalog, series_id, title, frequency))
    count, batch = 0, []
    for number, row in enumerate(reader, 2):
        for catalog, series_id, column, frequency in mappings:
            batch.append((catalog, series_id, row["indice_tiempo"], row[column], frequency, entry["sha256"], number))
            count += 1
        if len(batch) >= 10000:
            connection.executemany("INSERT INTO observacion VALUES(?,?,?,?,?,?,?)", batch)
            batch.clear()
    connection.executemany("INSERT INTO observacion VALUES(?,?,?,?,?,?,?)", batch)
    return {"url": entry["url"], "series_mapeadas": len(mappings), "observaciones": count}


def csv_content(path: Path):
    data = path.read_bytes()
    try:
        text, encoding = data.decode("utf-8-sig"), "utf-8-sig"
    except UnicodeDecodeError:
        text, encoding = data.decode("cp1252"), "cp1252"
    if text.lstrip().lower().startswith(("<!doctype html", "<html")):
        raise ValueError("El servidor devolvió HTML en lugar del CSV")
    # El separador se detecta sobre el encabezado, sin interpretar decimales.
    header = text.splitlines()[0] if text else ""
    delimiter = ";" if header.count(";") > header.count(",") else ","
    return text, encoding, delimiter


def import_raw_csv(connection, path: Path, sha256: str) -> int:
    text, encoding, delimiter = csv_content(path)
    reader = csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)
    headers = next(reader, [])
    if not headers or (len(headers) == 1 and "<html" in headers[0].lower()):
        raise ValueError("El recurso no tiene encabezado CSV válido")
    batch, count = [], 0
    for number, cells in enumerate(reader, 2):
        batch.append((sha256, number, encoded(cells)))
        count += 1
        if len(batch) >= 10000:
            connection.executemany("INSERT INTO fila_csv VALUES(?,?,?)", batch)
            batch.clear()
    connection.executemany("INSERT INTO fila_csv VALUES(?,?,?)", batch)
    connection.execute("INSERT INTO recurso_csv VALUES(?,?,?,?,?)",
                       (sha256, encoded(headers), encoding, delimiter, count))
    return count


def import_sectorial(connection, path: Path, entry: dict, dictionary_path: Path | None) -> dict:
    dictionary = {}
    if dictionary_path:
        text, _, delimiter = csv_content(dictionary_path)
        for row in csv.DictReader(io.StringIO(text), delimiter=delimiter):
            dictionary.setdefault(row["variable_id"], []).append(row)
    text, _, delimiter = csv_content(path)
    reader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    required = {"sector_id", "sector_nombre", "variable_id", "frecuencia_nombre",
                "alcance_tipo", "alcance_id", "indice_tiempo", "valor"}
    if set(reader.fieldnames or ()) != required:
        raise ValueError("Cambió el esquema de valores provinciales/sectoriales")
    seen, batch, count = set(), [], 0
    for number, row in enumerate(reader, 2):
        dimensions = {key: row[key] for key in ("sector_id", "variable_id", "frecuencia_nombre", "alcance_tipo", "alcance_id")}
        series_id = hashlib.sha256(encoded(dimensions).encode()).hexdigest()[:24]
        if series_id not in seen:
            candidates = [d for d in dictionary.get(row["variable_id"], [])
                          if d["frecuencia_nombre"] == row["frecuencia_nombre"]
                          and d["alcance_tipo"] == row["alcance_tipo"]]
            details = candidates[0] if len(candidates) == 1 else {}
            title = " · ".join(filter(None, [details.get("actividad_producto_nombre"), details.get("indicador"),
                                            row["sector_nombre"], row["alcance_tipo"], row["alcance_id"]]))
            connection.execute("INSERT OR IGNORE INTO serie VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
                "economia_sectorial", series_id, title, details.get("variable_descripcion", ""),
                details.get("unidad_de_medida", ""), row["frecuencia_nombre"], details.get("fuente", ""),
                row["sector_nombre"], entry["url"], encoded({"dimensiones": dimensions, "diccionario": details}),
                entry["sha256"], number))
            seen.add(series_id)
        batch.append(("economia_sectorial", series_id, row["indice_tiempo"], row["valor"],
                      row["frecuencia_nombre"], entry["sha256"], number))
        count += 1
        if len(batch) >= 10000:
            connection.executemany("INSERT INTO observacion VALUES(?,?,?,?,?,?,?)", batch)
            batch.clear()
    connection.executemany("INSERT INTO observacion VALUES(?,?,?,?,?,?,?)", batch)
    return {"series": len(seen), "observaciones": count}


def import_pilot(connection, path: Path) -> dict:
    bundle = json.loads(path.read_text())
    available = [s for s in bundle["series"] if s["available"]]
    count = 0
    for source in bundle["inputs"]:
        original = (ROOT / "datos/originales" / source["file"]).resolve()
        original.relative_to((ROOT / "datos/originales").resolve())
        if hashlib.sha256(original.read_bytes()).hexdigest() != source["sha256"]:
            raise ValueError("El original del piloto no coincide con su hash")
        connection.execute("INSERT OR IGNORE INTO archivo VALUES(?,?,?)", (source["sha256"], source_path(original), original.stat().st_size))
        connection.execute("INSERT INTO descarga(sha256,url,estado,detalle_json) VALUES(?,?,?,?)", (
            source["sha256"], source["url"], "descargado", encoded(source)))
    for series in available:
        connection.execute("INSERT INTO serie VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
            "club_local", series["id"], series["name"], series["basis"], series["unit"],
            series["frequency"], series["source"], series["topic"], series["source_url"],
            encoded(series), None, None))
        for point in series["observations"]:
            originals = series["originals"]
            source = next((o for o in originals if point["date"][:4] in o["file"]), originals[-1])
            connection.execute("INSERT INTO observacion VALUES(?,?,?,?,?,?,?)", (
                "club_local", series["id"], point["date"], str(point["value"]), series["frequency"],
                source["sha256"], source.get("source_row", series["source_row"])))
            count += 1
    return {"series": len(available), "observaciones": count, "release_id": bundle["release_id"]}


def _build(manifest_path: Path, destination: Path = DESTINATION, pilot_path: Path | None = None) -> dict:
    manifest_path = manifest_path.resolve()
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("schema_version") != 1 or not manifest.get("completed_at"):
        raise ValueError("La recolección debe estar terminada")
    entries = manifest["files"]
    paths = {}
    for entry in entries:
        if entry["status"] == "descargado":
            paths[entry["sha256"]] = verified_file(manifest_path, entry)
    metadata = next(e for e in entries if e["kind"] == "metadatos" and e["status"] == "descargado")
    global_values = next(e for e in entries if e["kind"] == "valores" and e["status"] == "descargado")
    catalogs = {e["catalogo_id"]: e for e in entries if e["kind"] == "valores_catalogo" and e["status"] == "descargado"}
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / "economia.sqlite"
    temporary = destination / "economia.sqlite.tmp"
    temporary.unlink(missing_ok=True)
    connection = sqlite3.connect(temporary)
    connection.execute("PRAGMA journal_mode=DELETE")
    connection.execute("PRAGMA synchronous=NORMAL")
    try:
        connection.executescript(SCHEMA)
        for sha256, path in paths.items():
            connection.execute("INSERT INTO archivo VALUES(?,?,?)", (sha256, source_path(path), path.stat().st_size))
        connection.executemany("INSERT INTO descarga(sha256,url,estado,detalle_json) VALUES(?,?,?,?)", [
            (e.get("sha256"), e["url"], e["status"], encoded(e)) for e in entries])
        metadata_rows = import_metadata(connection, paths[metadata["sha256"]], metadata["sha256"])
        for entry in entries:
            if entry["kind"] == "metadatos_catalogo" and entry["status"] == "descargado":
                import_metadata(connection, paths[entry["sha256"]], entry["sha256"])
        print("Metadatos", len(metadata_rows), flush=True)
        value_counts = {}
        for catalog, entry in sorted(catalogs.items()):
            value_counts[catalog] = import_values(connection, paths[entry["sha256"]], entry, set())
            print("Valores", catalog, value_counts[catalog], flush=True)
        # Se conservan todas las versiones y sus filas de origen. La vista valores
        # colapsa solo copias con cinco campos textualmente idénticos; no elige
        # entre cifras distintas para el mismo período ni convierte decimales.
        value_counts["global"] = import_values(connection, paths[global_values["sha256"]], global_values, set())
        for entry in entries:
            if entry["kind"] == "fuentes" and entry["status"] == "descargado":
                with paths[entry["sha256"]].open(encoding="utf-8-sig", newline="") as stream:
                    connection.executemany("INSERT INTO fuente VALUES(?,?,?)", [
                        (n, encoded(row), entry["sha256"]) for n, row in enumerate(csv.DictReader(stream), 2)])
        raw_counts, raw_errors = {}, []
        for entry in entries:
            if entry["kind"] not in ("recurso", "distribucion_faltante") or entry["status"] != "descargado" or not entry["file"].endswith(".csv"):
                continue
            if entry["sha256"] in raw_counts:
                continue
            connection.execute("SAVEPOINT csv_resource")
            try:
                raw_counts[entry["sha256"]] = import_raw_csv(connection, paths[entry["sha256"]], entry["sha256"])
                connection.execute("RELEASE csv_resource")
            except (ValueError, UnicodeError, csv.Error) as error:
                connection.execute("ROLLBACK TO csv_resource")
                connection.execute("RELEASE csv_resource")
                raw_errors.append({"url": entry["url"], "error": str(error)})
        distributions = []
        for entry in entries:
            if entry["kind"] == "distribucion_faltante" and entry["status"] == "descargado" and entry["sha256"] in raw_counts:
                distributions.append(import_distribution(connection, paths[entry["sha256"]], entry))
        sector_entry = next((e for e in entries if e["status"] == "descargado"
                             and e["url"].endswith("/nuevo_dataset/valores.csv")), None)
        dictionary_entry = next((e for e in entries if e["status"] == "descargado"
                                 and e["url"].endswith("/diccionario-de-variables.csv")), None)
        sector_result = import_sectorial(connection, paths[sector_entry["sha256"]], sector_entry,
                                        paths[dictionary_entry["sha256"]] if dictionary_entry else None) if sector_entry else {}
        pilot_result = import_pilot(connection, pilot_path) if pilot_path else {}
        connection.execute("CREATE INDEX observacion_serie ON observacion(catalogo_id,serie_id,periodo)")
        connection.execute("CREATE INDEX serie_titulo ON serie(titulo)")
        missing_metadata = connection.execute("""SELECT DISTINCT o.catalogo_id,o.serie_id,o.frecuencia
            FROM observacion o LEFT JOIN serie s USING(catalogo_id,serie_id) WHERE s.serie_id IS NULL""").fetchall()
        for catalog, series_id, frequency in missing_metadata:
            connection.execute("INSERT OR IGNORE INTO serie VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
                catalog, series_id, series_id, "Serie presente en los valores; sin ficha de metadatos coincidente",
                "", frequency, "", "", "", encoded({"metadatos_pendientes": True}), None, None))
        connection.executescript("""
        CREATE VIEW valores AS SELECT DISTINCT catalogo_id,serie_id,periodo,valor,frecuencia FROM observacion;
        CREATE TABLE cobertura AS
        SELECT catalogo_id,serie_id,COUNT(*) AS observaciones,MIN(periodo) AS inicio,MAX(periodo) AS fin
        FROM valores WHERE valor IS NOT NULL AND valor<>'' GROUP BY catalogo_id,serie_id;
        CREATE UNIQUE INDEX cobertura_serie ON cobertura(catalogo_id,serie_id);
        CREATE VIEW catalogo AS SELECT s.*,COALESCE(c.observaciones,0) AS observaciones,c.inicio,c.fin
        FROM serie s LEFT JOIN cobertura c USING(catalogo_id,serie_id);
        """)
        actual = {(c, s): n for c, s, n in connection.execute("SELECT catalogo_id,serie_id,observaciones FROM cobertura")}
        mismatches = [{"catalogo_id": row["catalogo_id"], "serie_id": row["serie_id"],
                       "declaradas": int(row["serie_valores_cant"] or 0),
                       "importadas": actual.get((row["catalogo_id"], row["serie_id"]), 0)}
                      for row in metadata_rows
                      if int(row["serie_valores_cant"] or 0) != actual.get((row["catalogo_id"], row["serie_id"]), 0)]
        summary = {
            "schema_version": 1, "manifest": source_path(manifest_path),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "series_catalogadas": connection.execute("SELECT COUNT(*) FROM serie").fetchone()[0],
            "series_con_observaciones": connection.execute("SELECT COUNT(*) FROM cobertura").fetchone()[0],
            "observaciones": connection.execute("SELECT SUM(observaciones) FROM cobertura").fetchone()[0],
            "registros_con_procedencia": connection.execute("SELECT COUNT(*) FROM observacion").fetchone()[0],
            "registros_faltantes_conservados": connection.execute("SELECT COUNT(*) FROM observacion WHERE valor IS NULL OR valor=''").fetchone()[0],
            "series_dump_metadatos": len(metadata_rows), "valores_por_catalogo": value_counts,
            "sectorial": sector_result, "piloto_local": pilot_result, "csv_adicionales": len(raw_counts),
            "filas_csv_adicionales": sum(raw_counts.values()), "errores_csv": raw_errors,
            "distribuciones_complementarias": distributions,
            "series_sin_ficha": len({(c, s) for c, s, f in missing_metadata}),
            "diferencias_con_metadatos": mismatches,
            "descargas": dict(collections.Counter(e["status"] for e in entries)),
            "pendientes": manifest.get("pending", []),
            "archivos_sin_parser": [{"url": e["url"], "file": e["file"]} for e in entries
                                    if e["status"] == "descargado" and e["kind"] == "recurso"
                                    and not e["file"].endswith(".csv")],
            "errores_descarga": [e for e in entries if e["status"] != "descargado"],
            "publicados": 0,
        }
        duplicates = connection.execute("""SELECT COUNT(*) FROM (
            SELECT 1 FROM valores WHERE valor IS NOT NULL AND valor<>''
            GROUP BY catalogo_id,serie_id,periodo HAVING COUNT(*)>1)""").fetchone()[0]
        summary["periodos_duplicados_conservados"] = duplicates
        summary["observaciones_sin_metadatos"] = connection.execute("""SELECT COUNT(*) FROM observacion o
            LEFT JOIN serie s USING(catalogo_id,serie_id) WHERE s.serie_id IS NULL""").fetchone()[0]
        for key, value in summary.items():
            connection.execute("INSERT INTO importacion VALUES(?,?)", (key, encoded(value)))
        connection.commit()
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("SQLite no superó integrity_check")
        with (destination / "catalogo_series.csv").open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            result = connection.execute("SELECT catalogo_id,serie_id,titulo,unidad,frecuencia,fuente,dataset,observaciones,inicio,fin FROM catalogo ORDER BY catalogo_id,serie_id")
            writer.writerow([column[0] for column in result.description])
            writer.writerows(result)
        with (destination / "cobertura_catalogos.csv").open("w", encoding="utf-8", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(["catalogo_id", "series", "series_con_valores", "observaciones"])
            writer.writerows(connection.execute("SELECT catalogo_id,COUNT(*),SUM(observaciones>0),SUM(observaciones) FROM catalogo GROUP BY catalogo_id"))
    except Exception:
        connection.close()
        temporary.unlink(missing_ok=True)
        raise
    connection.close()
    temporary.replace(target)
    (destination / "informe_importacion.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    write_report(summary, destination)
    return summary


def build(manifest_path: Path, destination: Path = DESTINATION, pilot_path: Path | None = None) -> dict:
    if __package__:
        from .bloqueo_base import database_lock
    else:
        from bloqueo_base import database_lock
    with database_lock(destination):
        return _build(manifest_path, destination, pilot_path)


def write_report(summary: dict, destination: Path) -> None:
    with (destination / "cobertura_catalogos.csv").open(newline="") as stream:
        coverage = list(csv.DictReader(stream))
    lines = ["# Importación masiva de series", "", "Recolección iniciada el 15 de octubre de 2026.", "",
             f"**{summary['series_catalogadas']:,} series catalogadas; {summary['series_con_observaciones']:,} con observaciones; "
             f"{summary['observaciones']:,} registros de valores distintos.**", "",
             "Base consultable: [economia.sqlite](economia.sqlite). "
             "Índice: [catalogo_series.csv](catalogo_series.csv). "
             "Registro de cobertura y pendientes: [informe_importacion.json](informe_importacion.json).", "",
             "## Cobertura", "", "| Catálogo | Series | Con valores | Valores distintos |",
             "| --- | ---: | ---: | ---: |"]
    for row in coverage:
        lines.append(f"| {row['catalogo_id']} | {row['series']} | {row['series_con_valores']} | {row['observaciones']} |")
    lines += ["", "Los nombres son los identificadores de los catálogos de origen; no equivalen a organismos actuales. "
              "El dump incluye series económicas y de otras temáticas, catálogos históricos y un nodo de prueba (`test_node`). "
              "`economia_sectorial` reúne el archivo de valores provinciales y sectoriales de Economía. "
              "`club_local` conserva las series IPC y TOP de la importación previa sin empalmarlas con las del portal.", "",
              "## Qué se conserva", "",
              "Cada original se identifica por SHA-256 y cada registro apunta al archivo y a su fila de origen. "
              "Las fechas de captura, las URLs y Last-Modified HTTP se guardan aparte. "
              "El índice y la base conservan los metadatos de publicación sin presentarlos como fecha de actualización verificada.", "",
              "Los números se almacenan como texto, con sus decimales y ceros originales. "
              "No se corrigen valores, no se completan faltantes, no se convierten monedas ni se agregan frecuencias. "
              "Las celdas vacías se conservan, pero no se cuentan como observaciones disponibles ni como revisiones. "
              "La tabla `observacion` conserva todas las procedencias. La vista `valores` reúne únicamente copias "
              "con catálogo, serie, período, valor y frecuencia textualmente idénticos. "
              "Dos cifras distintas del mismo período siguen disponibles y se exportan por separado.", "",
              "Los CSV adicionales también se guardan por fila como listas de celdas, incluidos encabezados repetidos "
              "y campos vacíos. Las distribuciones se vinculan por URL y nombre exacto de columna; no se adivinan correspondencias. "
              "El archivo sectorial usa sus identificadores de sector, variable, frecuencia y alcance; "
              "las unidades se unen al diccionario solo cuando hay una correspondencia única.", "",
              "## Pendientes medidos", "",
              f"- {summary['registros_faltantes_conservados']:,} registros de procedencia contienen celdas vacías; se conservan sin completar y no inflan la cobertura.",
              f"- {summary['series_catalogadas'] - summary['series_con_observaciones']:,} series catalogadas siguen sin valores descargados.",
              f"- {len(summary['diferencias_con_metadatos']):,} series del catálogo global tienen un conteo distinto del declarado en sus metadatos.",
              f"- {summary['periodos_duplicados_conservados']:,} períodos de series conservan más de un valor o frecuencia textual; no se elige una revisión.",
              f"- {summary['series_sin_ficha']:,} series aparecen en los valores sin una ficha de metadatos coincidente.",
              f"- {len(summary['archivos_sin_parser']):,} Excel/ZIP/otros recursos se descargaron como originales y esperan extracción específica.",
              f"- {len(summary['errores_descarga']):,} intentos terminaron con error; sus URLs y causas están en el informe.", "",
              "La descarga masiva global y los dumps por catálogo no tienen idéntica cobertura. "
              "Se conservaron y combinaron con procedencia en lugar de asumir que el global estaba completo. "
              "Algunos enlaces originales ya no funcionan y parte del material es histórico. "
              "La cobertura corresponde a los paquetes y enlaces efectivamente consultados, no a todas las publicaciones "
              "que pueden existir en cada sitio.", "",
              "## Consultar y exportar", "", "Desde la raíz del proyecto:", "", "```bash",
              ".venv/bin/python scripts/consultar_base.py buscar 'actividad' --catalogo sspm --limite 10",
              ".venv/bin/python scripts/consultar_base.py exportar --catalogo CATALOGO --serie ID --salida outputs/serie.csv",
              "```", "",
              "La exportación crea un CSV y una ficha JSON de procedencia. SQLite se abre en modo de solo lectura. "
              "También puede consultarse con DB Browser for SQLite u otra herramienta compatible.", "",
              "## Reproducir", "", "```bash",
              ".venv/bin/python scripts/importar_masivo.py --manifiesto " + summary["manifest"],
              "```", "",
              "Esta base es una importación local sin revisión de cifras. El agente y la limpieza quedan pendientes. "
              "No modifica datos aprobados ni publica en Supabase. ChartBay conserva su catálogo local de 31 series; "
              "el catálogo masivo se consulta con SQLite y el buscador/exportador de este proyecto.", ""]
    (destination / "README.md").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifiesto", required=True, type=Path)
    parser.add_argument("--destino", type=Path, default=DESTINATION)
    parser.add_argument("--piloto", type=Path, default=ROOT / "datos/importadas/catalogo.json")
    args = parser.parse_args()
    result = build(args.manifiesto, args.destino, args.piloto if args.piloto.is_file() else None)
    print(json.dumps({key: result[key] for key in ("series_catalogadas", "series_con_observaciones", "observaciones", "csv_adicionales", "publicados")}, ensure_ascii=False))
