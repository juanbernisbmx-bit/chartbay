"""Public economic catalogue: approved Supabase releases, then their GitHub copy."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import re
import time
from threading import Lock
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.request import Request, urlopen


RELEASE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")
SERIE = re.compile(r"^[a-z0-9_]+$")
# Each Supabase answer (empty ones too) is reused for a while, and a failure is not retried at once:
# otherwise every visit would wait up to the 4 s timeout before falling back to the GitHub copy.
SUPABASE_TTL = 300
SUPABASE_RETRY = 60
_supabase_cache: dict[tuple, tuple[float, dict | None, dict | None]] = {}
_supabase_lock = Lock()


def _json_file(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schema_version") != 1:
        raise ValueError("Formato de catálogo no compatible")
    return value


def read_pilot_snapshot(root: Path) -> dict:
    """Temporary reader for the existing public pilot until the first approved release."""
    directory = Path(os.environ.get("CHARTBAY_DATA_DIR") or root / "datasets" / "economia")
    catalogue = _json_file(directory / "catalogo.json")
    series = catalogue.get("series")
    if not isinstance(series, list):
        raise ValueError("El catálogo de series no es válido")
    ids = [item["id"] for item in series]
    if len(set(ids)) != len(ids):
        raise ValueError("El catálogo contiene identificadores repetidos")
    return {**catalogue, "source": "pilot"}


def _snapshot(releases: list[dict], origin: str) -> dict:
    by_id = {}
    release_ids = []
    for release in releases:
        release_id = release.get("release_id")
        if not isinstance(release_id, str) or not RELEASE.fullmatch(release_id):
            raise ValueError("Identificador de publicación inválido")
        if not release.get("license") or not release.get("attribution"):
            raise ValueError("Una fuente publicada no tiene licencia o atribución")
        release_ids.append(release_id)
        inputs = release.get("inputs", [])
        if not isinstance(inputs, list):
            raise ValueError("Procedencia inválida")
        inputs_by_key = {a.get("clave", a.get("file")): a for a in inputs if isinstance(a, dict)}
        for item in release.get("series", []):
            series_id = item.get("id")
            if not isinstance(series_id, str) or not SERIE.fullmatch(series_id):
                raise ValueError("Identificador de serie inválido")
            observations = item.get("observations")
            if not isinstance(observations, list) or not observations:
                raise ValueError("Una serie publicada no tiene observaciones")
            dates = [o.get("date") for o in observations]
            if dates != sorted(set(dates)) or any(not re.fullmatch(r"\d{4}-\d{2}-01", d or "") for d in dates):
                raise ValueError("Fechas publicadas inválidas")
            if len(observations) != item.get("count") or dates[0] != item.get("start") or dates[-1] != item.get("end"):
                raise ValueError("La serie no coincide con su manifiesto")
            if any(isinstance(o.get("value"), bool) or not isinstance(o.get("value"), (int, float))
                   or not math.isfinite(o["value"]) for o in observations):
                raise ValueError("Valores publicados inválidos")
            original = inputs_by_key.get(item.get("input_key", item.get("file")))
            original = {key: original.get(key) for key in ("url", "sha256", "retrieved_at", "published_at")} if original else None
            previous = by_id.get(series_id, {})
            by_id[series_id] = {**previous, **{key: item.get(key, previous.get(key)) for key in (
                "id", "name", "topic", "level", "territory", "classification", "frequency", "unit", "basis",
            )}, "source_id": release["source_id"], "source": release["source"],
                "source_url": release.get("source_url") or "", "release_id": release_id,
                "pending": "", "available": True, "status": "Publicado",
                "start": item["start"], "end": item["end"], "count": item["count"], "original": original,
                "sheet": item.get("sheet"), "source_row": int(item["source_row"]) if item.get("source_row") is not None else None,
                "normalization_notes": item.get("normalization_notes") or [], "observations": observations,
                "license": release.get("license"), "license_url": release.get("license_url"),
                "attribution": release.get("attribution")}
    return {"schema_version": 1, "release_id": ", ".join(release_ids) if release_ids else "Sin publicaciones",
            "source": origin, "series": list(by_id.values())}


def _from_supabase(url: str, key: str) -> dict:
    request = Request(url.rstrip("/") + "/rest/v1/rpc/catalogo_economico_publicado",
                      data=b"{}", headers={"apikey": key, "Content-Type": "application/json"}, method="POST")
    with urlopen(request, timeout=4) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or payload.get("schema_version") != 1 or not isinstance(payload.get("sources"), list):
        raise ValueError("Respuesta pública de Supabase incompatible")
    return _snapshot(payload["sources"], "supabase")


def _from_github(root: Path) -> dict:
    directory = root / "datasets" / "economia" / "publicado"
    catalogue = _json_file(directory / "catalogo.json")
    sources = catalogue.get("sources")
    releases = catalogue.get("releases")
    if not isinstance(sources, dict) or not isinstance(releases, list):
        raise ValueError("Copia publicada inválida")
    by_release = {r.get("release_id"): r for r in releases if isinstance(r, dict)}
    current = []
    for source_id, source in sources.items():
        release_id = source.get("current")
        if not isinstance(release_id, str) or not RELEASE.fullmatch(release_id) or release_id not in by_release:
            raise ValueError("El catálogo apunta a un release inexistente")
        record = by_release[release_id]
        path = directory / "releases" / release_id / "manifiesto.json"
        raw = path.read_bytes()
        if record.get("manifest") != f"releases/{release_id}/manifiesto.json" or hashlib.sha256(raw).hexdigest() != record.get("sha256"):
            raise ValueError("El manifiesto publicado no coincide con el catálogo")
        manifest = json.loads(raw)
        if manifest.get("schema_version") != 1 or manifest.get("release_id") != release_id or manifest.get("source_id") != source_id:
            raise ValueError("Manifiesto publicado inválido")
        if not manifest.get("license") or not manifest.get("attribution"):
            raise ValueError("La fuente no tiene licencia o atribución")
        content_lines = []
        for item in manifest.get("series", []):
            series_id = item.get("id")
            if not isinstance(series_id, str) or not SERIE.fullmatch(series_id) or item.get("csv") != f"{series_id}.csv":
                raise ValueError("CSV publicado inválido")
            csv_bytes = (path.parent / item["csv"]).read_bytes()
            if hashlib.sha256(csv_bytes).hexdigest() != item.get("sha256"):
                raise ValueError("CSV publicado modificado")
            rows = list(csv.DictReader(io.StringIO(csv_bytes.decode("utf-8"))))
            if not rows or set(rows[0]) != {"fecha", "valor"}:
                raise ValueError("Formato de CSV publicado inválido")
            observations = []
            for row in rows:
                try:
                    value = Decimal(row["valor"])
                    if not value.is_finite():
                        raise InvalidOperation
                except (InvalidOperation, TypeError):
                    raise ValueError("Valor de CSV publicado inválido") from None
                content_lines.append(f"{series_id}|{row['fecha']}|{format(value.normalize(), 'f')}")
                observations.append({"date": row["fecha"], "value": float(value)})
            item["observations"] = observations
        digest = hashlib.sha256("\n".join(sorted(content_lines)).encode("utf-8")).hexdigest()
        if digest != manifest.get("content_sha256"):
            raise ValueError("El contenido publicado no coincide con el release aprobado")
        current.append(manifest)
    return _snapshot(current, "github")


def _cached_supabase(root: Path, url: str, key: str) -> dict | None:
    """Reuse a live answer for five minutes; keep the last approved one across outages."""
    cache_key = (str(root), url, hashlib.sha256(key.encode()).digest())
    with _supabase_lock:
        now = time.monotonic()
        cached = _supabase_cache.get(cache_key)
        if cached and now < cached[0]:
            return cached[1] or ({**cached[2], "source": "supabase_cache"} if cached[2] else None)
        try:
            live = _from_supabase(url, key)
        except (OSError, ValueError, TypeError, KeyError):
            last_good = cached[2] if cached else None
            _supabase_cache[cache_key] = (now + SUPABASE_RETRY, None, last_good)
            return {**last_good, "source": "supabase_cache"} if last_good else None
        last_good = live if live["series"] else (cached[2] if cached else None)
        _supabase_cache[cache_key] = (now + SUPABASE_TTL, live, last_good)
        return live


def read_snapshot(root: Path, supabase_url: str = "", supabase_key: str = "") -> dict:
    """Try live published data, then the approved copy in this GitHub checkout."""
    if supabase_url and supabase_key:
        live = _cached_supabase(root, supabase_url, supabase_key)
        if live and any(s["available"] for s in live["series"]):
            return live
    try:
        copy = _from_github(root)
        if any(s["available"] for s in copy["series"]):
            return copy
    except (OSError, ValueError, TypeError, KeyError):
        pass
    return _snapshot([], "sin_publicaciones")
