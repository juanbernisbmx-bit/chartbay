"""Consulta fuentes vencidas y agrega novedades a SQLite; apto para systemd/cron.

Ejecutar una vez por hora. La periodicidad y los reintentos se deciden aquí, sin IA.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

if __package__:
    from . import importar_masivo as importer, recolectar_masivo as downloader
    from .bloqueo_base import database_lock
else:
    import importar_masivo as importer
    import recolectar_masivo as downloader
    from bloqueo_base import database_lock

ROOT = importer.ROOT
DEFAULT_CONFIG = ROOT / "config/actualizacion.json"
DEFAULT_DATABASE = ROOT / "datos/base/economia.sqlite"
DEFAULT_STATE = ROOT / "datos/actualizaciones/control.sqlite"
ALIASES = {"Diaria": "R/P1D", "Diario": "R/P1D", "Semanal": "R/P1W",
           "Mensual": "R/P1M", "Trimestral": "R/P3M", "Semestral": "R/P6M", "Anual": "R/P1Y"}


def utcnow():
    return datetime.now(timezone.utc)


def moment(value):
    date = datetime.fromisoformat(value)
    if date.tzinfo is None:
        raise ValueError("Una fecha de programación debe tener zona horaria")
    return date.astimezone(timezone.utc)


def load_config(path=DEFAULT_CONFIG):
    config = json.loads(path.read_text(encoding="utf-8"))
    if config.get("version") != 1:
        raise ValueError("Versión de configuración no compatible")
    numbers = list(config["consulta_horas_por_frecuencia"].values()) + [
        config[key] for key in ("metadatos_globales_horas", "max_trabajos_por_ejecucion",
                               "reintento_inicial_horas", "reintento_maximo_horas")]
    numbers += [o["cada_horas"] for o in config.get("trabajos", {}).values() if "cada_horas" in o]
    if any(isinstance(n, bool) or not isinstance(n, (int, float)) or n <= 0 for n in numbers):
        raise ValueError("Los intervalos y límites deben ser positivos")
    for override in config.get("trabajos", {}).values():
        if set(override) - {"cada_horas", "activo"}:
            raise ValueError("Un trabajo solo admite cada_horas y activo como ajustes")
        if "activo" in override and not isinstance(override["activo"], bool):
            raise ValueError("activo debe ser un booleano")
    return config


def interval(frequencies, config):
    rules = config["consulta_horas_por_frecuencia"]
    return min((rules.get(ALIASES.get(f, f), rules["desconocida"]) for f in frequencies),
               default=rules["desconocida"])


def safe_url(url):
    parsed = urlsplit(url)
    if parsed.scheme == "http" and downloader.official_host(parsed.hostname):
        url = urlunsplit(parsed._replace(scheme="https"))
    if not downloader.official(url):
        raise ValueError("URL no admitida por el recolector")
    return url


def jobs_from_database(connection, config):
    catalogs, distributions = {}, {}
    for catalog, series_id, frequency, url in connection.execute("SELECT catalogo_id,serie_id,frecuencia,url FROM serie"):
        if catalog in config["catalogos_excluidos"]:
            continue
        if catalog not in ("club_local", "economia_sectorial"):
            group = catalogs.setdefault(catalog, {"frequencies": set(), "series": 0})
            group["frequencies"].add(frequency)
            group["series"] += 1
        if catalog in ("club_local", "economia_sectorial") or not url:
            continue
        try:
            url = safe_url(url)
        except ValueError:
            continue
        if not urlsplit(url).path.lower().endswith(".csv"):
            continue
        group = distributions.setdefault(url, {"frequencies": set(), "series": 0})
        group["frequencies"].add(frequency)
        group["series"] += 1
    jobs = [{"id": "metadatos_globales", "type": "metadata", "cada_horas": config["metadatos_globales_horas"],
             "series": 0, "resources": [{"kind": "metadatos", "url": downloader.BULK["metadatos"]}]}]
    for catalog, group in sorted(catalogs.items()):
        jobs.append({"id": "catalogo:" + catalog, "type": "catalog", "catalogo_id": catalog,
                     "cada_horas": interval(group["frequencies"], config), "series": group["series"],
                     "resources": [{"kind": "metadatos_catalogo", "url": downloader.BASE + catalog + "/series-tiempo-metadatos.csv"},
                                   {"kind": "valores_catalogo", "url": downloader.BASE + catalog + "/series-tiempo-valores-csv.zip", "catalogo_id": catalog}]})
    for url, group in sorted(distributions.items()):
        jobs.append({"id": "csv:" + hashlib.sha256(url.encode()).hexdigest()[:16], "type": "csv",
                     "cada_horas": interval(group["frequencies"], config), "series": group["series"],
                     "resources": [{"kind": "distribucion_faltante", "url": url}]})
    sector = connection.execute("SELECT DISTINCT url,frecuencia FROM serie WHERE catalogo_id='economia_sectorial'").fetchall()
    if sector:
        url = sector[0][0]
        jobs.append({"id": "economia_sectorial", "type": "sector", "cada_horas": interval([r[1] for r in sector], config),
                     "series": connection.execute("SELECT COUNT(*) FROM serie WHERE catalogo_id='economia_sectorial'").fetchone()[0],
                     "resources": [{"kind": "recurso", "url": url.replace("/valores.csv", "/diccionario-de-variables.csv")},
                                   {"kind": "recurso", "url": url}]})
    for name, prefix in (("ipc", "ipc_ng_"), ("top", "top_mensual_")):
        count = connection.execute("SELECT COUNT(*) FROM serie WHERE catalogo_id='club_local' AND serie_id LIKE ?", (prefix + "%",)).fetchone()[0]
        if count:
            jobs.append({"id": "club:" + name, "type": name, "cada_horas": interval(["Mensual"], config),
                         "series": count, "resources": []})
    for job in jobs:
        override = config.get("trabajos", {}).get(job["id"], {})
        job.update(override)
        job.setdefault("activo", True)
    return jobs


def state_connection(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    state = sqlite3.connect(path)
    state.row_factory = sqlite3.Row
    state.executescript("""
    CREATE TABLE IF NOT EXISTS trabajo(id TEXT PRIMARY KEY, ultimo_intento TEXT, ultimo_exito TEXT,
      proxima_consulta TEXT, fallos INTEGER NOT NULL DEFAULT 0, estado TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS recurso(url TEXT PRIMARY KEY, detalle_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS corrida(id INTEGER PRIMARY KEY, trabajo_id TEXT, inicio TEXT,
      fin TEXT, estado TEXT, informe_json TEXT);
    """)
    return state


def previous_downloads(connection):
    previous = {}
    for url, raw in connection.execute("SELECT url,detalle_json FROM descarga WHERE estado='descargado' ORDER BY id"):
        entry = json.loads(raw)
        entry.setdefault("url", url)
        # Los originales del piloto tienen rutas relativas a datos/originales.
        if entry.get("file") and not (downloader.RAW / entry["file"]).is_file():
            candidate = ROOT / "datos/originales" / entry["file"]
            if candidate.is_file():
                entry["local_path"] = str(candidate)
        previous[url] = entry
    return previous


def schedule(job, state, previous, now):
    saved = state.execute("SELECT * FROM trabajo WHERE id=?", (job["id"],)).fetchone()
    if saved and saved["ultimo_exito"] and not saved["fallos"]:
        due = moment(saved["ultimo_exito"]) + timedelta(hours=job["cada_horas"])
    elif saved and saved["proxima_consulta"]:
        due = moment(saved["proxima_consulta"])
    else:
        entries = [previous.get(r["url"], {}) for r in job["resources"]]
        dates = [moment(e["retrieved_at"]) for e in entries if e.get("retrieved_at")]
        due = min(dates) + timedelta(hours=job["cada_horas"]) if entries and len(dates) == len(entries) else now
    return {**job, "proxima_consulta": due.isoformat(), "vencido": job["activo"] and due <= now,
            "estado_anterior": saved["estado"] if saved else "sin_ejecutar"}


def digest_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cached_path(entry):
    return Path(entry["local_path"]) if entry.get("local_path") else downloader.RAW / entry["file"]


def download_resources(job, state, previous):
    entries = []
    for resource in job["resources"]:
        cached = state.execute("SELECT detalle_json FROM recurso WHERE url=?", (resource["url"],)).fetchone()
        cached = json.loads(cached[0]) if cached else previous.get(resource["url"])
        valid_cache = bool(cached and cached.get("file") and cached_path(cached).is_file()
                           and digest_file(cached_path(cached)) == cached.get("sha256"))
        result = downloader.collect_one(resource["url"], resource["kind"], validators=cached if valid_cache else None)
        if result["status"] == "sin_cambios":
            if not valid_cache:
                raise ValueError("HTTP 304 sin original local válido")
            result = {**cached, **result, "status": "descargado"}
        elif result["status"] != "descargado":
            raise ValueError(result.get("error", "Descarga fallida"))
        result.update({key: value for key, value in resource.items() if key != "url"})
        entries.append(result)
    return entries


def prepare_ledger(connection):
    existed = connection.execute("SELECT 1 FROM sqlite_master WHERE name='actualizacion_archivo'").fetchone()
    connection.execute("""CREATE TABLE IF NOT EXISTS actualizacion_archivo(
      sha256 TEXT, parser TEXT, importado_en TEXT, PRIMARY KEY(sha256,parser))""")
    if not existed:
        # Se ejecuta una sola vez; evita volver a insertar los originales ya cargados.
        connection.execute("""INSERT OR IGNORE INTO actualizacion_archivo
          SELECT DISTINCT archivo_sha256,'valores',? FROM observacion WHERE archivo_sha256 IS NOT NULL""", (utcnow().isoformat(),))
        connection.execute("""INSERT OR IGNORE INTO actualizacion_archivo
          SELECT DISTINCT archivo_sha256,'metadata',? FROM metadato""", (utcnow().isoformat(),))


def club_payload(job):
    if job["type"] == "ipc":
        if __package__:
            from . import recolectar_ipc, ipc_indec
        else:
            import recolectar_ipc, ipc_indec
        path = recolectar_ipc.collect()
        files, loaded = ipc_indec.load_candidate(path)
        catalog = json.loads((ROOT / "datos/importadas/catalogo.json").read_text())
        by_id = {s["id"]: s for s in catalog["series"]}
        payload = []
        for series_id, data in loaded.items():
            source = next(f for f in files if f["file"] == data["file"])
            source = {**source, "local_path": str(path.parent / source["file"]), "sheet": data["sheet"], "source_row": data["row"]}
            payload.append(({**by_id[series_id], "observations": data["observations"]}, [source]))
        return payload
    if __package__:
        from . import recolectar_top, importar_top
    else:
        import recolectar_top, importar_top
    path = recolectar_top.collect()
    bundle = importar_top.build(path)
    return [(s, [{**o, "local_path": str(path.parent / o["file"])} for o in s["originals"]])
            for s in bundle["series"] if s["id"].startswith("top_mensual_")]


def ingest(connection, job, entries, payload=None):
    """Una transacción por fuente. Los ayudantes escriben en una tabla temporal."""
    connection.execute("BEGIN IMMEDIATE")
    try:
        prepare_ledger(connection)
        connection.execute("CREATE TEMP TABLE observacion AS SELECT * FROM main.observacion LIMIT 0")
        accepted = []
        for entry in entries:
            path = cached_path(entry)
            if not path.is_file() or digest_file(path) != entry["sha256"]:
                raise ValueError("Original perdido o alterado antes de importar")
            connection.execute("INSERT OR IGNORE INTO archivo VALUES(?,?,?)", (entry["sha256"], importer.source_path(path), path.stat().st_size))
            connection.execute("INSERT INTO descarga(sha256,url,estado,detalle_json) VALUES(?,?,?,?)", (
                entry["sha256"], entry["url"], "descargado", importer.encoded(entry)))
            parser = "metadata" if entry["kind"].startswith("metadatos") else "valores"
            if connection.execute("SELECT 1 FROM actualizacion_archivo WHERE sha256=? AND parser=?", (entry["sha256"], parser)).fetchone():
                continue
            if parser == "metadata":
                importer.import_metadata(connection, path, entry["sha256"])
            elif job["type"] == "catalog":
                if importer.import_values(connection, path, entry, set()) == 0:
                    raise ValueError("El dump de valores está vacío")
            elif job["type"] == "csv":
                result = importer.import_distribution(connection, path, entry)
                if result.get("observaciones", 0) == 0:
                    raise ValueError("El CSV no tiene columnas y valores compatibles: " + str(result))
            elif job["type"] == "sector":
                # El diccionario se conserva junto con el archivo de valores.
                if not entry["url"].endswith("/valores.csv"):
                    continue
                dictionary = next(e for e in entries if e["url"].endswith("/diccionario-de-variables.csv"))
                importer.import_sectorial(connection, path, entry, cached_path(dictionary))
            accepted.append((entry["sha256"], parser, utcnow().isoformat()))
        for series, sources in payload or []:
            connection.execute("INSERT OR IGNORE INTO serie VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", (
                "club_local", series["id"], series["name"], series["basis"], series["unit"], series["frequency"],
                series["source"], series["topic"], series["source_url"], importer.encoded(series), None, None))
            for source in sources:
                path = Path(source["local_path"])
                if digest_file(path) != source["sha256"]:
                    raise ValueError("Original IPC/TOP alterado")
                connection.execute("INSERT OR IGNORE INTO archivo VALUES(?,?,?)", (source["sha256"], importer.source_path(path), path.stat().st_size))
                connection.execute("INSERT INTO descarga(sha256,url,estado,detalle_json) VALUES(?,?,?,?)", (
                    source["sha256"], source["url"], "descargado", importer.encoded(source)))
            for point in series["observations"]:
                source = next((s for s in sources if point["date"][:4] in s["file"]), sources[-1])
                connection.execute("INSERT INTO temp.observacion VALUES(?,?,?,?,?,?,?)", (
                    "club_local", series["id"], point["date"], str(point["value"]), series["frequency"],
                    source["sha256"], source.get("source_row", series["source_row"])))
        connection.execute("CREATE TEMP TABLE afectadas AS SELECT DISTINCT catalogo_id,serie_id FROM temp.observacion")
        connection.execute("""INSERT OR IGNORE INTO serie
          SELECT DISTINCT o.catalogo_id,o.serie_id,o.serie_id,'Sin metadatos coincidentes','',o.frecuencia,
          '','','','{}',NULL,NULL FROM temp.observacion o""")
        # A igualdad textual no se vuelve a copiar el histórico completo en cada revisión.
        before = connection.total_changes
        connection.execute("""INSERT INTO main.observacion
          SELECT DISTINCT n.* FROM temp.observacion n WHERE NOT EXISTS(
            SELECT 1 FROM main.observacion p WHERE p.catalogo_id=n.catalogo_id AND p.serie_id=n.serie_id
            AND p.periodo IS n.periodo AND p.valor IS n.valor AND p.frecuencia IS n.frecuencia)""")
        added = connection.total_changes - before
        connection.execute("""DELETE FROM cobertura WHERE (catalogo_id,serie_id) IN (SELECT * FROM afectadas)""")
        connection.execute("""INSERT INTO cobertura SELECT catalogo_id,serie_id,COUNT(*),MIN(periodo),MAX(periodo)
          FROM (SELECT DISTINCT o.catalogo_id,o.serie_id,o.periodo,o.valor,o.frecuencia FROM main.observacion o
                JOIN afectadas a USING(catalogo_id,serie_id) WHERE o.valor IS NOT NULL AND o.valor<>'')
          GROUP BY catalogo_id,serie_id""")
        connection.executemany("INSERT OR IGNORE INTO actualizacion_archivo VALUES(?,?,?)", accepted)
        connection.execute("INSERT OR REPLACE INTO importacion VALUES('ultima_actualizacion_automatica',?)", (
            importer.encoded({"trabajo": job["id"], "momento": utcnow().isoformat(), "registros_nuevos": added}),))
        connection.commit()
        return added
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.execute("DROP TABLE IF EXISTS temp.afectadas")
        connection.execute("DROP TABLE IF EXISTS temp.observacion")


def run_job(connection, state, job, config, previous, now, fetcher=download_resources):
    start = now.isoformat()
    cursor = state.execute("INSERT INTO corrida(trabajo_id,inicio,estado) VALUES(?,?,'en_curso')", (job["id"], start))
    state.commit()
    entries = []
    try:
        if job["type"] in ("ipc", "top"):
            added = ingest(connection, job, [], club_payload(job))
        else:
            entries = fetcher(job, state, previous)
            added = ingest(connection, job, entries)
        for entry in entries:
            state.execute("INSERT OR REPLACE INTO recurso VALUES(?,?)", (entry["url"], importer.encoded(entry)))
        finish = utcnow()
        outcome = {"trabajo": job["id"], "estado": "actualizado" if added else "sin_cambios", "registros_nuevos": added}
        failures, error, success = 0, None, finish.isoformat()
        next_check = finish + timedelta(hours=job["cada_horas"])
    except Exception as exc:
        finish = utcnow()
        saved = state.execute("SELECT fallos,ultimo_exito FROM trabajo WHERE id=?", (job["id"],)).fetchone()
        failures = (saved["fallos"] if saved else 0) + 1
        success = saved["ultimo_exito"] if saved else None
        error = str(exc)
        delay = min(config["reintento_maximo_horas"], config["reintento_inicial_horas"] * 2 ** min(failures - 1, 10))
        next_check = finish + timedelta(hours=delay)
        outcome = {"trabajo": job["id"], "estado": "error", "error": error}
    state.execute("INSERT OR REPLACE INTO trabajo VALUES(?,?,?,?,?,?,?)", (
        job["id"], start, success, next_check.isoformat(), failures, outcome["estado"], error))
    state.execute("UPDATE corrida SET fin=?,estado=?,informe_json=? WHERE id=?", (
        finish.isoformat(), outcome["estado"], importer.encoded({**outcome, "archivos": entries}), cursor.lastrowid))
    state.commit()
    return {**outcome, "proxima_consulta": next_check.isoformat()}


def export_status(connection, state, directory):
    """Índices actuales separados del informe histórico de la importación inicial."""
    queries = {
        "catalogo_series.csv": "SELECT catalogo_id,serie_id,titulo,unidad,frecuencia,fuente,dataset,observaciones,inicio,fin FROM catalogo ORDER BY catalogo_id,serie_id",
        "cobertura_catalogos.csv": "SELECT catalogo_id,COUNT(*) AS series,SUM(observaciones>0) AS series_con_valores,SUM(observaciones) AS observaciones FROM catalogo GROUP BY catalogo_id",
    }
    for filename, sql in queries.items():
        target = directory / filename
        temporary = target.with_suffix(".csv.tmp")
        with temporary.open("w", encoding="utf-8", newline="") as stream:
            result = connection.execute(sql)
            writer = csv.writer(stream)
            writer.writerow([column[0] for column in result.description])
            writer.writerows(result)
        temporary.replace(target)
    status = {"generado_en": utcnow().isoformat(),
              "series_catalogadas": connection.execute("SELECT COUNT(*) FROM serie").fetchone()[0],
              "series_con_observaciones": connection.execute("SELECT COUNT(*) FROM cobertura").fetchone()[0],
              "observaciones": connection.execute("SELECT COALESCE(SUM(observaciones),0) FROM cobertura").fetchone()[0],
              "trabajos": [dict(r) for r in state.execute("SELECT * FROM trabajo ORDER BY id")]}
    temporary = directory / "estado_actualizacion.json.tmp"
    temporary.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(directory / "estado_actualizacion.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("comando", choices=("plan", "ejecutar", "estado"))
    parser.add_argument("--base", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--control", type=Path, default=DEFAULT_STATE)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--trabajo", help="Seleccionar un trabajo exacto, por ejemplo catalogo:sspm")
    parser.add_argument("--forzar", action="store_true", help="Consultar aunque el trabajo aún no esté vencido")
    parser.add_argument("--limite", type=int)
    args = parser.parse_args()
    config = load_config(args.config)
    if not args.base.is_file():
        parser.error("La base no existe; realizar primero la importación inicial")
    state = state_connection(args.control)
    if args.comando == "estado":
        print(json.dumps([dict(r) for r in state.execute("SELECT * FROM trabajo ORDER BY id")], ensure_ascii=False, indent=2))
        state.close()
        return 0
    connection = sqlite3.connect(args.base.resolve().as_uri() + "?mode=rw", uri=True, timeout=30)
    try:
        with database_lock(args.base.parent):
            now = utcnow()
            previous = previous_downloads(connection)
            jobs = [schedule(job, state, previous, now) for job in jobs_from_database(connection, config)]
            if args.trabajo:
                jobs = [job for job in jobs if job["id"] == args.trabajo]
                if not jobs:
                    parser.error("No existe ese trabajo")
            if args.comando == "plan":
                print(json.dumps(jobs, ensure_ascii=False, indent=2))
                return 0
            limit = args.limite if args.limite is not None else int(config["max_trabajos_por_ejecucion"])
            if limit <= 0:
                parser.error("--limite debe ser positivo")
            due = sorted((job for job in jobs if job["activo"] and (args.forzar or job["vencido"])),
                         key=lambda job: job["proxima_consulta"])[:limit]
            outcomes = []
            for job in due:
                result = run_job(connection, state, job, config, previous, now)
                outcomes.append(result)
                print(json.dumps(result, ensure_ascii=False), flush=True)
            export_status(connection, state, args.base.parent)
            print(json.dumps({"revisados": len(outcomes), "errores": sum(r["estado"] == "error" for r in outcomes),
                              "vencidos_restantes": sum(j["activo"] and (args.forzar or j["vencido"]) for j in jobs) - len(due),
                              "publicados": 0}))
            return 1 if any(r["estado"] == "error" for r in outcomes) else 0
    finally:
        connection.close()
        state.close()


if __name__ == "__main__":
    sys.exit(main())
