"""Conserva las descargas masivas de Datos Argentina y enlaces directos oficiales.

No transforma valores ni publica. Cada intento queda en un manifiesto, incluidos
errores y límites. --solo-base descarga los tres archivos de series de tiempo.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import json
import re
import sqlite3
import subprocess
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "datos/originales/masivo"
OFFICIAL_HOSTS = {
    "www.argentina.gob.ar", "argentina.gob.ar", "apis.datos.gob.ar",
    "www.mecon.gob.ar", "www.economia.gob.ar", "infra.datos.gob.ar",
    "www.datos.gob.ar", "datos.gob.ar", "www.indec.gob.ar", "api.indec.gob.ar",
    "www.bcra.gob.ar", "api.bcra.gob.ar", "datos.magyp.gob.ar", "www.magyp.gob.ar",
    "datos.estadistica.ec.gba.gov.ar", "datosestadistica.cba.gov.ar",
    "www.estadisticaciudad.gob.ar", "datos.energia.gob.ar",
}
BASE = "https://apis.datos.gob.ar/series/api/dump/"
BULK = {
    "metadatos": BASE + "series-tiempo-metadatos.csv",
    "valores": BASE + "series-tiempo-valores-csv.zip",
    "fuentes": BASE + "series-tiempo-fuentes.csv",
}
SEEDS = [
    "https://www.argentina.gob.ar/economia/datos",
    "https://www.argentina.gob.ar/economia/politicaeconomica/regionalysectorial/informesproductivos/datasets",
]
MAX_BYTES = 128 * 1024 * 1024
MAX_RESOURCES = 250


def official_host(host: str | None) -> bool:
    return bool(host and (host in OFFICIAL_HOSTS or host.endswith((".gob.ar", ".gov.ar"))))


def official(url: str) -> bool:
    parsed = urlsplit(url)
    return (parsed.scheme == "https" and official_host(parsed.hostname)
            and not parsed.username and not parsed.password
            and parsed.port in (None, 443))


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not official(newurl):
            raise ValueError("Redirección fuera de los dominios HTTPS oficiales permitidos")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def public_url(url: str) -> str:
    # Las redirecciones del portal pueden usar URLs firmadas temporales.
    return urlunsplit(urlsplit(url)._replace(query="", fragment=""))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def collect_with_system_tls(url: str, kind: str, source_page: str | None = None,
                            validators: dict | None = None) -> dict:
    """Usa las CA del sistema, sin -k, y valida cada redirección antes de seguirla."""
    entry = {"url": url, "kind": kind, "source_page": source_page,
             "retrieved_at": now(), "transport": "curl_system_tls"}
    RAW.mkdir(parents=True, exist_ok=True)
    token = hashlib.sha256(url.encode()).hexdigest()[:20]
    partial, headers_path = RAW / (token + ".part"), RAW / (token + ".headers")
    current = url
    try:
        for _ in range(6):
            if not official(current):
                raise ValueError("Redirección fuera de los dominios HTTPS oficiales permitidos")
            arguments = [
                "curl", "--silent", "--show-error", "--proto", "=https",
                "--max-time", "60", "--max-filesize", str(MAX_BYTES),
                "--user-agent", "ClubEconomiaArchivo/1.0", "--dump-header", str(headers_path),
                "--output", str(partial), "--write-out", "%{http_code}",
            ]
            for key, value in conditional_headers(validators).items():
                arguments.extend(["--header", key + ": " + value])
            result = subprocess.run(arguments + [current], capture_output=True, text=True, check=True)
            headers = headers_path.read_text(encoding="iso-8859-1")
            fields = {}
            for line in headers.splitlines():
                if ":" in line:
                    key, value = line.split(":", 1)
                    fields[key.lower()] = value.strip()
            status = int(result.stdout)
            if status == 304:
                return {**entry, "status": "sin_cambios", "http_status": 304}
            if 300 <= status < 400 and "location" in fields:
                current = urljoin(current, fields["location"])
                continue
            if status != 200:
                raise ValueError(f"HTTP {status}")
            size = partial.stat().st_size
            if not size or size > MAX_BYTES:
                raise ValueError("Tamaño vacío o superior al límite")
            sha256 = hashlib.sha256(partial.read_bytes()).hexdigest()
            extension = Path(urlsplit(current).path).suffix.lower()
            extension = extension if extension in (".csv", ".zip", ".xlsx", ".xls", ".json") else ".html"
            target = RAW / (sha256 + extension)
            if target.exists():
                if hashlib.sha256(target.read_bytes()).hexdigest() != sha256:
                    raise ValueError("Original conservado alterado")
                partial.unlink()
            else:
                partial.replace(target)
            return {**entry, "status": "descargado", "file": target.name, "sha256": sha256,
                    "bytes": size, "final_url": public_url(current),
                    "http_last_modified": fields.get("last-modified"),
                    "etag": fields.get("etag"), "http_status": 200,
                    "content_type": fields.get("content-type"), "published_at": None}
        raise ValueError("Demasiadas redirecciones")
    except Exception as error:
        return {**entry, "status": "error", "error": f"{type(error).__name__}: "
                + re.sub(r"https?://\S+", "[URL]", str(error))}
    finally:
        partial.unlink(missing_ok=True)
        headers_path.unlink(missing_ok=True)


def conditional_headers(validators: dict | None) -> dict:
    headers = {}
    for key, field in (("If-None-Match", "etag"), ("If-Modified-Since", "http_last_modified")):
        value = (validators or {}).get(field)
        if value:
            if not isinstance(value, str) or "\r" in value or "\n" in value:
                raise ValueError("Validador HTTP inválido")
            headers[key] = value
    return headers


def collect_one(url: str, kind: str, source_page: str | None = None,
                validators: dict | None = None) -> dict:
    entry = {"url": url, "kind": kind, "source_page": source_page, "retrieved_at": now()}
    if not official(url):
        return {**entry, "status": "pendiente", "error": "Dominio o protocolo no permitido"}
    partial = None
    try:
        RAW.mkdir(parents=True, exist_ok=True)
        token = hashlib.sha256(url.encode()).hexdigest()[:20]
        partial = RAW / (token + ".part")
        request = Request(url, headers={"User-Agent": "ClubEconomiaArchivo/1.0", **conditional_headers(validators)})
        opener = build_opener(SafeRedirect())
        with opener.open(request, timeout=40) as response, partial.open("wb") as output:
            size = response.headers.get("Content-Length")
            if size and int(size) > MAX_BYTES:
                raise ValueError("Supera el límite de 128 MiB por archivo de esta recolección")
            digest, count = hashlib.sha256(), 0
            while chunk := response.read(1024 * 1024):
                count += len(chunk)
                if count > MAX_BYTES:
                    raise ValueError("Supera el límite de 128 MiB por archivo de esta recolección")
                output.write(chunk)
                digest.update(chunk)
            extension = Path(urlsplit(response.url).path).suffix.lower()
            if extension not in (".csv", ".zip", ".xlsx", ".xls", ".json"):
                extension = ".html" if kind == "pagina" else ".bin"
            sha256 = digest.hexdigest()
            final = RAW / (sha256 + extension)
            entry.update(status="descargado", file=final.name, sha256=sha256, bytes=count,
                         final_url=public_url(response.url),
                         content_type=response.headers.get("Content-Type"),
                         http_last_modified=response.headers.get("Last-Modified"), published_at=None)
            entry.update(etag=response.headers.get("ETag"), http_status=200)
        if final.exists():
            if hashlib.sha256(final.read_bytes()).hexdigest() != sha256:
                raise ValueError("El original conservado no coincide con su SHA-256")
            partial.unlink()
        else:
            partial.replace(final)
        return entry
    except Exception as error:
        if partial and partial.exists():
            partial.unlink()
        if isinstance(error, HTTPError) and error.code == 304:
            return {**entry, "status": "sin_cambios", "http_status": 304}
        if "CERTIFICATE_VERIFY_FAILED" in str(error):
            return collect_with_system_tls(url, kind, source_page, validators)
        # No guardar las query strings firmadas ni credenciales de redirecciones.
        message = re.sub(r"https?://\S+", "[URL]", str(error))
        return {**entry, "status": "error", "error": f"{type(error).__name__}: {message}"}


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.hrefs.append(href)


def resource_links(content: str, base: str) -> list[str]:
    parser = Links()
    parser.feed(content)
    result = set()
    for href in parser.hrefs:
        href = href.removeprefix("blank:#")
        url = urljoin(base, href)
        parsed = urlsplit(url)
        if parsed.scheme == "http" and official_host(parsed.hostname):
            url = urlunsplit(parsed._replace(scheme="https"))
        if official(url) and re.search(r"\.(csv|xlsx|xls|zip|json)$", urlsplit(url).path, re.I):
            result.add(url)
    return sorted(result)


def save(manifest: dict, path: Path) -> None:
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def collect(only_bulk: bool = False) -> Path:
    RAW.mkdir(parents=True, exist_ok=True)
    path = RAW / (datetime.now(timezone.utc).strftime("manifiesto_%Y%m%dT%H%M%S%fZ.json"))
    manifest = {"schema_version": 1, "started_at": now(), "files": [], "pending": [],
                "scope": "Dump global Datos Argentina y enlaces directos de las páginas inventariadas; sin rastreo recursivo",
                "max_bytes_per_file": MAX_BYTES, "max_direct_resources": MAX_RESOURCES}
    tasks = [(url, kind, None) for kind, url in BULK.items()]
    if not only_bulk:
        seeds = list(SEEDS)
        with (ROOT / "catalogo/fuentes.csv").open(newline="") as stream:
            for source in csv.DictReader(stream):
                url = source["url_publicacion"]
                if official(url):
                    seeds.append(url)
                else:
                    manifest["pending"].append({"source_id": source["fuente_id"], "url": url,
                                                "reason": "Fuente fuera del recolector oficial; acceso específico pendiente"})
        resources = {}
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(collect_one, url, "pagina"): url for url in dict.fromkeys(seeds)}
            for future in concurrent.futures.as_completed(futures):
                entry = future.result()
                manifest["files"].append(entry)
                print(entry["status"], entry["url"], flush=True)
                if entry["status"] == "descargado":
                    body = (RAW / entry["file"]).read_text(encoding="utf-8", errors="replace")
                    for url in resource_links(body, entry["url"]):
                        resources.setdefault(url, entry["url"])
                save(manifest, path)
        bulk_urls = set(BULK.values())
        for url, page in sorted(resources.items()):
            # No duplicar todos los formatos del mismo dump (XLSX, DTA, etc.).
            if "/series/api/dump/" in url:
                continue
            if len(tasks) - len(BULK) >= MAX_RESOURCES:
                manifest["pending"].append({"url": url, "reason": "Límite de recursos de la primera pasada"})
            elif url not in bulk_urls:
                tasks.append((url, "recurso", page))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(collect_one, *task) for task in tasks]
        for future in concurrent.futures.as_completed(futures):
            entry = future.result()
            manifest["files"].append(entry)
            print(entry["status"], entry["kind"], entry["url"], entry.get("bytes", ""), flush=True)
            save(manifest, path)
    manifest["completed_at"] = now()
    save(manifest, path)
    print("MANIFIESTO", path, flush=True)
    return path


def retry(path: Path) -> None:
    manifest = json.loads(path.read_text())
    failed = [entry for entry in manifest["files"] if entry["status"] == "error"]
    manifest.setdefault("previous_attempts", []).extend(failed)
    manifest["files"] = [entry for entry in manifest["files"] if entry["status"] != "error"]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(collect_one, entry["url"], entry["kind"], entry.get("source_page")): entry
                   for entry in failed}
        for future in concurrent.futures.as_completed(futures):
            entry = future.result()
            if "catalogo_id" in futures[future]:
                entry["catalogo_id"] = futures[future]["catalogo_id"]
            manifest["files"].append(entry)
            print(entry["status"], entry["url"], flush=True)
            save(manifest, path)
    manifest["completed_at"] = now()
    save(manifest, path)


def collect_catalogs(path: Path) -> None:
    manifest = json.loads(path.read_text())
    metadata = next(f for f in manifest["files"] if f["kind"] == "metadatos" and f["status"] == "descargado")
    with (path.parent / metadata["file"]).open(encoding="utf-8-sig", newline="") as stream:
        catalogs = sorted({row["catalogo_id"] for row in csv.DictReader(stream)})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(collect_one, BASE + catalog + "/series-tiempo-valores-csv.zip",
                               "valores_catalogo"): catalog for catalog in catalogs}
        for future in concurrent.futures.as_completed(futures):
            entry = {**future.result(), "catalogo_id": futures[future]}
            manifest["files"].append(entry)
            print(entry["status"], entry["catalogo_id"], entry.get("bytes", ""), flush=True)
            save(manifest, path)
    manifest["completed_at"] = now()
    save(manifest, path)


def collect_complements(path: Path, database: Path) -> None:
    manifest = json.loads(path.read_text())
    connection = sqlite3.connect(f"file:{database.resolve()}?mode=ro", uri=True)
    missing = connection.execute("SELECT metadatos_json FROM catalogo WHERE observaciones=0").fetchall()
    connection.close()
    urls = set()
    for (raw,) in missing:
        row = json.loads(raw)
        url = row.get("distribucion_url_descarga", "")
        parsed = urlsplit(url)
        if parsed.scheme == "http" and official_host(parsed.hostname):
            url = urlunsplit(parsed._replace(scheme="https"))
        if official(url) and urlsplit(url).path.lower().endswith(".csv"):
            urls.add(url)
        elif url:
            manifest["pending"].append({"url": url, "reason": "Distribución sin descarga CSV HTTPS oficial admitida"})
    existing = {e["url"] for e in manifest["files"] if e["status"] == "descargado"}
    tasks = [(url, "distribucion_faltante", None) for url in sorted(urls - existing)]
    catalogs = sorted({e["catalogo_id"] for e in manifest["files"] if e["kind"] == "valores_catalogo" and e["status"] == "descargado"})
    tasks += [(BASE + c + "/series-tiempo-metadatos.csv", "metadatos_catalogo", None) for c in catalogs
              if BASE + c + "/series-tiempo-metadatos.csv" not in existing]
    # Ambos dominios son del Ministerio; comprobar la alternativa sin suponer
    # que funciona ni sustituir el original que falló en el historial.
    tasks += [(e["url"].replace("https://www.economia.gob.ar/", "https://www.mecon.gob.ar/"),
               "distribucion_faltante" if e["kind"] == "distribucion_faltante" else "recurso", e.get("source_page"))
              for e in manifest["files"] if e["status"] == "error" and e["url"].startswith("https://www.economia.gob.ar/")
              and e["url"].replace("https://www.economia.gob.ar/", "https://www.mecon.gob.ar/") not in existing]
    tasks = list(dict.fromkeys(tasks))
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = [pool.submit(collect_one, *task) for task in tasks]
        for future in concurrent.futures.as_completed(futures):
            entry = future.result()
            manifest["files"].append(entry)
            print(entry["status"], entry["kind"], entry["url"], flush=True)
            save(manifest, path)
    manifest["completed_at"] = now()
    manifest["pending"] = list({json.dumps(e, sort_keys=True): e for e in manifest["pending"]}.values())
    save(manifest, path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solo-base", action="store_true")
    parser.add_argument("--reintentar", type=Path, help="Reintentar fallos conservando el historial de intentos")
    parser.add_argument("--catalogos", type=Path, help="Descargar valores por cada catálogo del dump de metadatos")
    parser.add_argument("--completar", type=Path, help="Buscar distribuciones de series sin valores y metadatos por catálogo")
    parser.add_argument("--base", type=Path, default=ROOT / "datos/base/economia.sqlite")
    args = parser.parse_args()
    if args.completar:
        collect_complements(args.completar, args.base)
    elif args.catalogos:
        collect_catalogs(args.catalogos)
    elif args.reintentar:
        retry(args.reintentar)
    else:
        collect(args.solo_base)
