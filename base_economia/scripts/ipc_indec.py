"""Validación reproducible de candidatas IPC; no escribe ni publica el piloto."""
from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlparse

import xlrd

if __package__:
    from . import preparar_piloto as pilot
else:
    import preparar_piloto as pilot

PAGE = "https://www.indec.gob.ar/Nivel4/Tema/3/5/31"
BASELINE = pilot.ROOT / "datos/piloto/catalogo.json"
SPECS = {
    "nacional": ("Índices IPC Cobertura Nacional", {"Total nacional": "ipc_ng_nacional"}),
    "regiones": ("Índices aperturas", pilot.REGIONS),
}
IDS = {"ipc_ng_nacional", *pilot.REGIONS.values()}
NATIONAL = re.compile(r"/ftp/cuadros/economia/sh_ipc_(0[1-9]|1[0-2])_\d{2}\.xls")
REGIONAL = "/ftp/cuadros/economia/sh_ipc_aperturas.xls"


def digest(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


def official_url(url: str) -> str:
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname != "www.indec.gob.ar"
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.fragment):
        raise ValueError("La URL debe pertenecer a https://www.indec.gob.ar")
    return url


def file_role(url: str) -> str | None:
    official_url(url)
    parsed = urlparse(url)
    if parsed.query:
        return None
    if NATIONAL.fullmatch(parsed.path):
        return "nacional"
    if parsed.path == REGIONAL:
        return "regiones"
    return None


def moment(value: str) -> datetime:
    try:
        result = datetime.fromisoformat(value)
        if result.tzinfo is None:
            raise ValueError
        return result
    except (TypeError, ValueError):
        raise ValueError("Fecha inválida o sin zona horaria") from None


def extract(path: Path, role: str) -> dict:
    """Controles estrictos adicionales al parser del piloto, sin cambiar su salida."""
    sheet_name, mapping = SPECS[role]
    book = xlrd.open_workbook(path)
    try:
        sheet = book.sheet_by_name(sheet_name)
        labels = [str(sheet.cell_value(row, 0)).strip() for row in range(sheet.nrows)]
        if "Período de referencia: Diciembre 2016=100" not in labels:
            raise ValueError("Cambió el rótulo de base del IPC")
        for label in mapping:
            if labels.count(label) != 1:
                raise ValueError(f"Falta o se repite la región {label}")
            row = labels.index(label)
            stop = next((r for r in range(row + 1, sheet.nrows)
                         if labels[r] == "Total nacional" or labels[r].startswith("Región ")),
                        sheet.nrows)
            levels = [r for r in range(row + 1, stop) if labels[r] == "Nivel general"]
            if len(levels) != 1:
                raise ValueError(f"Nivel general ambiguo para {label}")
            for column in range(1, sheet.ncols):
                if (sheet.cell(row, column).ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK)
                        and sheet.cell(levels[0], column).ctype not in
                        (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK)):
                    raise ValueError(f"Valor sin encabezado mensual en {label}, columna {column + 1}")
    finally:
        book.release_resources()
    return pilot.extract(path, sheet_name, mapping)


def check_series(series: dict) -> None:
    if set(series) != IDS:
        raise ValueError("Se requieren nacional y exactamente seis regiones IPC")
    calendars = {}
    for key, data in series.items():
        observations = data["observations"]
        dates = [item["date"] for item in observations]
        # También se aplica a la base comparada, que puede venir de otro JSON.
        if (not dates or dates[0] != "2016-12-01" or observations[0]["value"] != 100
                or any(not isinstance(o["value"], (int, float)) or isinstance(o["value"], bool)
                       or not math.isfinite(o["value"]) or o["value"] <= 0 for o in observations)):
            raise ValueError(f"Base o valores inválidos en {key}")
        if any(not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])-01", day) for day in dates):
            raise ValueError(f"Período mensual inválido en {key}")
        if any(pilot.month_number(b) - pilot.month_number(a) != 1 for a, b in zip(dates, dates[1:])):
            raise ValueError(f"Meses duplicados, huecos o desorden en {key}")
        calendars[key] = dates
    if len({tuple(days) for days in calendars.values()}) != 1:
        detail = ", ".join(f"{key}: {days[0][:7]} a {days[-1][:7]} ({len(days)})"
                           for key, days in sorted(calendars.items()))
        raise ValueError(f"Coberturas mensuales desalineadas: {detail}")


def baseline_series(bundle: dict) -> dict:
    items = [s for s in bundle["series"] if s["id"] in IDS]
    if len(items) != 7:
        raise ValueError("La base comparada debe contener las siete series IPC sin duplicados")
    result = {s["id"]: s for s in items}
    check_series(result)
    return result


def compare(series: dict, baseline: dict) -> dict:
    previous = baseline_series(baseline)
    revisions, additions, removals = [], [], []
    for key in sorted(IDS):
        old = {o["date"]: o["value"] for o in previous[key]["observations"]}
        new = {o["date"]: o["value"] for o in series[key]["observations"]}
        for day in sorted(old.keys() & new.keys()):
            if old[day] != new[day]:
                revisions.append({"series_id": key, "date": day, "previous": old[day], "candidate": new[day]})
        additions.extend({"series_id": key, "date": day, "value": new[day]} for day in sorted(new.keys() - old.keys()))
        removals.extend({"series_id": key, "date": day, "value": old[day]} for day in sorted(old.keys() - new.keys()))
    return {"revisions": revisions, "additions": additions, "removals": removals,
            "counts": {"revisions": len(revisions), "additions": len(additions), "removals": len(removals)}}


def read_original(folder: Path, entry: dict, prefix: str, suffix: str) -> bytes:
    sha = entry["sha256"]
    if not re.fullmatch(r"[0-9a-f]{64}", sha) or entry["file"] != f"{prefix}_{sha}.{suffix}":
        raise ValueError("Nombre o hash de original inválido")
    body = (folder / entry["file"]).read_bytes()
    if digest(body) != sha or len(body) != entry["bytes"]:
        raise ValueError(f"Original alterado: {entry['file']}")
    return body


def validate_dates(entry: dict) -> None:
    captured = moment(entry["retrieved_at"])
    for field, raw in (("http_last_modified_at", "http_last_modified_raw"), ("http_date_at", "http_date_raw")):
        try:
            header = parsedate_to_datetime(entry[raw]) if entry[raw] else None
            if header is not None and header.tzinfo is None:
                raise ValueError
        except (TypeError, ValueError, OverflowError):
            raise ValueError(f"Encabezado HTTP inválido: {raw}") from None
        if (moment(entry[field]) if entry[field] is not None else None) != header:
            raise ValueError(f"Fecha {field} no coincide con su encabezado HTTP")
        if entry[field] is not None and moment(entry[field]) > captured:
            raise ValueError(f"{field} posterior a la captura")
    # v1 no atribuye a un XLS la fecha de un informe o del servidor.
    if entry["published_at"] is not None:
        raise ValueError("v1 requiere published_at nulo: no hay evidencia de publicación del XLS")


def evaluate(folder: Path, manifest: dict) -> tuple[dict, dict]:
    """Reextrae de originales verificados; no confía en cifras guardadas en el JSON."""
    baseline = json.loads(read_original(folder, manifest["baseline"], "ipc_base", "json"))
    if baseline["release_id"] != manifest["baseline"]["release_id"]:
        raise ValueError("Identificador de base comparada alterado")
    page = manifest["page"]
    read_original(folder, page, "ipc_pagina", "html")
    for entry in [page, *manifest["files"]]:
        official_url(entry["url"])
        official_url(entry["requested_url"])
        validate_dates(entry)
    entries = manifest["files"]
    if len(entries) != 2 or {e["role"] for e in entries} != set(SPECS):
        raise ValueError("Se requieren los dos originales IPC: nacional y regiones")
    loaded = {}
    for entry in entries:
        if any(file_role(entry[field]) != entry["role"] for field in ("url", "requested_url")):
            raise ValueError("URL IPC incompatible con el rol del original")
        read_original(folder, entry, "ipc", "xls")
        loaded.update(extract(folder / entry["file"], entry["role"]))
    check_series(loaded)
    return loaded, compare(loaded, baseline)


def load_candidate(path: Path, current_baseline: Path = BASELINE) -> tuple[list[dict], dict]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("status") != "candidata":
        raise ValueError("Manifiesto IPC incompatible, incompleto o rechazado")
    if digest(current_baseline.read_bytes()) != manifest["baseline"]["sha256"]:
        raise ValueError("Cambió el piloto de comparación: recolectar y revisar otra candidata")
    loaded, comparison = evaluate(path.parent, manifest)
    if comparison["removals"]:
        raise ValueError("La candidata perdió meses históricos")
    if manifest["series"] != loaded or manifest["comparison"] != comparison:
        raise ValueError("La extracción o comparación guardada fue alterada")
    return manifest["files"], loaded
