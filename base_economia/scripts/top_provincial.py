"""Extrae el total mensual de Cordoba de los originales TOP conservados."""
from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import datetime
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "datos" / "originales" / "top_manifest.json"
MONTHS = (
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
)


def extract_rows(rows: list[tuple], year: int, jurisdiction: str = "Córdoba",
                 allow_gaps: bool = False) -> tuple[list[dict], int]:
    if rows[2][1] != year or rows[3][1] != "en millones de pesos":
        raise ValueError(f"Cambio de anio o unidad en TOP {year}")
    headers = tuple(str(cell).strip() for cell in rows[5][2:14])
    if headers != MONTHS:
        raise ValueError(f"Cambio de encabezados mensuales en TOP {year}")
    matches = [(number, row) for number, row in enumerate(rows, 1)
               if len(row) > 1 and row[1] == jurisdiction]
    if len(matches) != 1:
        raise ValueError(f"No se identifica una unica fila {jurisdiction} en TOP {year}")
    row_number, row = matches[0]
    observations = []
    missing = False
    for month, value in enumerate(row[2:14], 1):
        if value is None or (not isinstance(value, bool) and value == 0):
            missing = True
            continue
        if (missing and not allow_gaps) or isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"Valor inesperado o hueco interior en TOP {year}-{month:02d}")
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"Valor no valido en TOP {year}-{month:02d}")
        observations.append({"date": f"{year}-{month:02d}-01", "value": value})
    if not observations:
        raise ValueError(f"Sin meses publicados en TOP {year}")
    total = row[14]
    if not isinstance(total, (int, float)) or not math.isfinite(total):
        raise ValueError(f"Total anual no valido en TOP {year}")
    if not math.isclose(sum(item["value"] for item in observations), total, rel_tol=1e-9, abs_tol=1e-6):
        raise ValueError(f"El total no coincide con los meses publicados en TOP {year}")
    return observations, row_number


def load(path: Path = MANIFEST, jurisdiction: str = "Córdoba",
         allow_gaps: bool = False) -> tuple[list[dict], dict]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    entries = manifest.get("files")
    if manifest.get("version") != 1 or not isinstance(entries, list) or not entries:
        raise ValueError("Manifiesto TOP no compatible")
    originals, observations, rows = [], [], []
    years = [item["year"] for item in entries]
    if years != list(range(years[0], years[-1] + 1)):
        raise ValueError("Los archivos TOP deben cubrir anios consecutivos")
    for entry in entries:
        if not re.fullmatch(r"(?:top_mensual_[0-9]{4}_[0-9]+|top_[0-9]{4}_[0-9a-f]{64})\.xlsx", entry["file"]):
            raise ValueError("Nombre de archivo TOP no valido")
        source = path.parent / entry["file"]
        sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
        if sha256 != entry["sha256"]:
            raise ValueError(f"Cambio el original TOP {entry['file']}")
        captured = datetime.fromisoformat(entry["retrieved_at"])
        last_modified = datetime.fromisoformat(entry["http_last_modified_at"])
        if not captured.tzinfo or not last_modified.tzinfo or last_modified > captured:
            raise ValueError(f"Fechas HTTP/captura invalidas para {entry['file']}")
        book = openpyxl.load_workbook(source, read_only=True, data_only=True)
        try:
            if "TOTAL" not in book.sheetnames:
                raise ValueError(f"Falta hoja TOTAL en {entry['file']}")
            extracted, row_number = extract_rows(list(book["TOTAL"].values), entry["year"],
                                                 jurisdiction, allow_gaps)
        finally:
            book.close()
        observations.extend(extracted)
        rows.append(row_number)
        original = {key: entry[key] for key in (
            "file", "url", "sha256", "retrieved_at", "http_last_modified_at"
        )}
        originals.append({**original, "published_at": None, "sheet": "TOTAL", "source_row": row_number})
    expected = [(year, month) for year in years for month in range(1, 13)]
    dates = [(int(item["date"][:4]), int(item["date"][5:7])) for item in observations]
    if not allow_gaps and dates != expected[:len(dates)]:
        raise ValueError("La serie TOP tiene huecos o meses fuera de orden")
    return originals, {
        "observations": observations,
        "originals": originals,
        "sheet": "TOTAL",
        "row": rows[0] if len(set(rows)) == 1 else None,
        "notes": [
            f"La fila de {jurisdiction} se indica por archivo en originals; varía entre años.",
            "Los ceros finales de meses sin informar se excluyen; no representan recaudacion nula.",
            "La fuente mensual replica reportes provinciales y puede incluir recursos no tributarios.",
            "Last-Modified HTTP no equivale necesariamente a fecha oficial de publicacion.",
        ],
    }
