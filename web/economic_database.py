"""Read the versioned local economic-data snapshot used by the pilot."""
from __future__ import annotations

import json
import os
from pathlib import Path


def read_snapshot(root: Path) -> dict:
    directory = Path(os.environ.get("CHARTBAY_DATA_DIR") or root / "datasets" / "economia")
    payload = json.loads((directory / "catalogo.json").read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1 or not isinstance(payload.get("series"), list):
        raise ValueError("Formato de catálogo no compatible")
    ids = [item["id"] for item in payload["series"]]
    if len(set(ids)) != len(ids):
        raise ValueError("El catálogo contiene identificadores repetidos")
    return payload
