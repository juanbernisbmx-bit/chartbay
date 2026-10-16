"""Recolecta IPC de INDEC como candidata local, sin modificar el piloto vigente."""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin
from urllib.request import HTTPRedirectHandler, Request, build_opener

if __package__:
    from . import ipc_indec as ipc
else:
    import ipc_indec as ipc

RAW_DIR = ipc.pilot.ROOT / "datos/originales/ipc"
MAX_BYTES = 15_000_000


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag == "a" and dict(attrs).get("href"):
            self.hrefs.append(dict(attrs)["href"])


def discover(html: str) -> dict[str, str]:
    links = Links()
    links.feed(html)
    found = {role: set() for role in ipc.SPECS}
    for href in links.hrefs:
        url = urljoin(ipc.PAGE, href)
        try:
            role = ipc.file_role(url)
        except ValueError:
            continue
        if role:
            found[role].add(url)
    if any(len(urls) != 1 for urls in found.values()):
        raise ValueError("No se identifica un único XLS nacional y uno de regiones en INDEC")
    return {role: next(iter(urls)) for role, urls in found.items()}


class OfficialRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        ipc.official_url(newurl)  # Rechaza antes de contactar el destino.
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url: str) -> tuple[bytes, dict]:
    ipc.official_url(url)
    request = Request(url, headers={"User-Agent": "ClubEconomiaIPC/1.0"})
    with build_opener(OfficialRedirect()).open(request, timeout=30) as response:
        ipc.official_url(response.geturl())
        if response.status != 200:
            raise ValueError(f"Respuesta HTTP inesperada: {response.status}")
        body = response.read(MAX_BYTES + 1)
        captured = datetime.now(timezone.utc).isoformat()
        if len(body) > MAX_BYTES:
            raise ValueError("Respuesta IPC excede el límite de 15 MB")
        return body, {"requested_url": url, "url": response.geturl(), "retrieved_at": captured,
                      "published_at": None, "http_status": response.status,
                      "http_last_modified_raw": response.headers.get("Last-Modified"),
                      "http_date_raw": response.headers.get("Date"),
                      "content_type": response.headers.get("Content-Type")}


def preserve(folder: Path, prefix: str, suffix: str, body: bytes) -> dict:
    """Publicación atómica sin reemplazo; verifica los objetos ya existentes."""
    sha = ipc.digest(body)
    name = f"{prefix}_{sha}.{suffix}"
    target = folder / name
    folder.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=folder, prefix=".ipc_", delete=False) as temp:
        temporary = Path(temp.name)
        temp.write(body)
        temp.flush()
        os.fsync(temp.fileno())
    try:
        try:
            os.link(temporary, target)
        except FileExistsError:
            if target.read_bytes() != body:
                raise ValueError(f"Original existente alterado: {name}")
    finally:
        temporary.unlink()
    return {"file": name, "sha256": sha, "bytes": len(body)}


def normalize_http(entry: dict) -> None:
    for raw, field in (("http_last_modified_raw", "http_last_modified_at"), ("http_date_raw", "http_date_at")):
        value = entry[raw]
        try:
            date = parsedate_to_datetime(value) if value else None
            if date is not None and date.tzinfo is None:
                raise ValueError
            entry[field] = date.astimezone(timezone.utc).isoformat() if date else None
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f"Encabezado HTTP inválido: {raw}") from None
    ipc.validate_dates(entry)


def collect(raw_dir: Path = RAW_DIR, baseline: Path = ipc.BASELINE) -> Path:
    raw_dir.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "_" + uuid.uuid4().hex[:8]
    report = {"version": 1, "candidate_id": f"ipc-{run_id}", "status": "rechazada",
              "started_at": datetime.now(timezone.utc).isoformat(), "source_page": ipc.PAGE,
              "files": [], "attempts": [], "errors": [], "series": {}, "comparison": None}
    path = raw_dir / f"ipc_candidato_{run_id}.json"

    def download(url, prefix, suffix, role):
        attempt = {"url": url, "started_at": datetime.now(timezone.utc).isoformat(), "role": role}
        report["attempts"].append(attempt)
        try:
            body, metadata = fetch(url)
            entry = {**preserve(raw_dir, prefix, suffix, body), **metadata}
            if role == "page":
                report["page"] = entry
            else:
                report["files"].append({**entry, "role": role})
                entry = report["files"][-1]
            # Se preserva el original incluso cuando sus metadatos o formato fallan.
            normalize_http(entry)
            attempt["status"] = "descargado"
            attempt["sha256"] = entry["sha256"]
            return body
        except Exception as error:
            attempt.update(status="error", error=f"{type(error).__name__}: {error}")
            raise
        finally:
            attempt["finished_at"] = datetime.now(timezone.utc).isoformat()

    try:
        base_body = baseline.read_bytes()
        base = json.loads(base_body)
        ipc.baseline_series(base)
        report["baseline"] = {**preserve(raw_dir, "ipc_base", "json", base_body), "release_id": base["release_id"]}
        page = download(ipc.PAGE, "ipc_pagina", "html", "page")
        urls = discover(page.decode("utf-8-sig"))
        for role, url in urls.items():
            download(url, "ipc", "xls", role)
        report["series"], report["comparison"] = ipc.evaluate(raw_dir, report)
        if report["comparison"]["removals"]:
            raise ValueError("La candidata perdió meses históricos respecto del piloto")
        report["status"] = "candidata"
    except Exception as error:
        report["errors"].append(f"{type(error).__name__}: {error}")
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    # Nombre exclusivo por corrida; la publicación del manifiesto es atómica.
    body = (json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()
    temp_entry = preserve(raw_dir, "ipc_informe", "json", body)
    os.link(raw_dir / temp_entry["file"], path)
    (raw_dir / temp_entry["file"]).unlink()
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw-dir", type=Path, default=RAW_DIR, help="Directorio separado de originales y candidatas IPC")
    parser.add_argument("--baseline", type=Path, default=ipc.BASELINE, help="Instantánea contra la cual detectar revisiones")
    parser.add_argument("--check-candidate", type=Path, help="Revalidar una candidata sin red ni escrituras")
    args = parser.parse_args()
    try:
        if args.check_candidate:
            files, series = ipc.load_candidate(args.check_candidate, args.baseline)
            report = json.loads(args.check_candidate.read_text(encoding="utf-8"))
            print(json.dumps({"status": "candidata", "files": len(files), "series": len(series),
                              "comparison": report["comparison"]["counts"], "publica": False}))
            return 0
        path = collect(args.raw_dir, args.baseline)
        report = json.loads(path.read_text(encoding="utf-8"))
        print(json.dumps({"manifest": str(path), "status": report["status"],
                          "errors": report["errors"], "publica": False}, ensure_ascii=False))
        return 0 if report["status"] == "candidata" else 1
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"No se pudo validar IPC: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
