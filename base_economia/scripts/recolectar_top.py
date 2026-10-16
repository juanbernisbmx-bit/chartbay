"""Descarga una candidata TOP sin alterar el piloto vigente."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

if __package__:
    from . import top_provincial
else:
    import top_provincial

PAGE = "https://www.argentina.gob.ar/economia/sechacienda/asuntosprovinciales/direccion-de-recursos-provinciales/recursos-tributarios-de-origen-provincial-top"
RAW_DIR = top_provincial.MANIFEST.parent
MAX_BYTES = 10_000_000
FILE_RE = re.compile(r"^/sites/default/files/top_mensual_(\d{4})_\d+\.xlsx$")


class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.hrefs.append(href)


def discover(html: str, starting_year: int = 2024) -> dict[int, str]:
    links = Links()
    links.feed(html)
    found: dict[int, str] = {}
    for href in links.hrefs:
        if href.startswith("blank:#"):
            href = href[len("blank:#"):]
        parsed = urlparse(urljoin(PAGE, href))
        match = FILE_RE.fullmatch(parsed.path)
        if parsed.scheme != "https" or parsed.hostname != "www.argentina.gob.ar" or not match:
            continue
        year = int(match.group(1))
        if year < starting_year:
            continue
        if year in found and found[year] != parsed.geturl():
            raise ValueError(f"Mas de un archivo TOP para {year}: revisar manualmente")
        found[year] = parsed.geturl()
    if not found or sorted(found) != list(range(starting_year, max(found) + 1)):
        raise ValueError("No se localizaron los anios TOP consecutivos esperados")
    return dict(sorted(found.items()))


def fetch(url: str) -> tuple[bytes, str | None, str]:
    request = Request(url, headers={"User-Agent": "ClubEconomiaPiloto/1.0"})
    with urlopen(request, timeout=30) as response:
        final_url = response.geturl()
        parsed = urlparse(final_url)
        if parsed.scheme != "https" or parsed.hostname != "www.argentina.gob.ar":
            raise ValueError("La descarga redirigio fuera del dominio oficial")
        body = response.read(MAX_BYTES + 1)
        if len(body) > MAX_BYTES:
            raise ValueError("Archivo TOP demasiado grande para el piloto")
        return body, response.headers.get("Last-Modified"), final_url


def collect() -> Path:
    page, _, _ = fetch(PAGE)
    discovered = discover(page.decode("utf-8"))
    entries = []
    for year, url in discovered.items():
        body, modified_header, final_url = fetch(url)
        if not body.startswith(b"PK\x03\x04") or not modified_header:
            raise ValueError(f"Archivo TOP {year} sin XLSX o Last-Modified verificable")
        modified = parsedate_to_datetime(modified_header)
        captured = datetime.now(timezone.utc)
        if modified.tzinfo is None or modified > captured:
            raise ValueError(f"Fecha HTTP invalida para TOP {year}")
        sha256 = hashlib.sha256(body).hexdigest()
        filename = f"top_{year}_{sha256}.xlsx"
        target = RAW_DIR / filename
        if target.exists():
            if hashlib.sha256(target.read_bytes()).hexdigest() != sha256:
                raise ValueError(f"Original existente alterado: {filename}")
        else:
            temporary = target.with_suffix(".xlsx.tmp")
            temporary.write_bytes(body)
            temporary.replace(target)
        entries.append({
            "year": year, "file": filename, "url": final_url, "sha256": sha256,
            "retrieved_at": captured.isoformat(),
            "http_last_modified_at": modified.astimezone(timezone.utc).isoformat(),
        })
    name = datetime.now(timezone.utc).strftime("top_candidato_%Y%m%dT%H%M%S%fZ.json")
    path = RAW_DIR / name
    path.write_text(json.dumps({"version": 1, "source_page": PAGE, "files": entries},
                               ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


if __name__ == "__main__":
    try:
        print(collect())
    except (OSError, ValueError, UnicodeError) as error:
        print(f"No se pudo recolectar TOP: {error}", file=sys.stderr)
        sys.exit(1)
