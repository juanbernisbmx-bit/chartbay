"""Prepara una instantánea local del IPC para probar ChartBay con datos INDEC."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import xlrd

if __package__:
    from . import top_provincial
else:
    import top_provincial

ROOT = Path(__file__).resolve().parents[1]
VERSION = 1
REGIONS = {
    "Región GBA": "ipc_ng_gba",
    "Región Pampeana": "ipc_ng_pampeana",
    "Región Noroeste": "ipc_ng_noa",
    "Región Noreste": "ipc_ng_nea",
    "Región Cuyo": "ipc_ng_cuyo",
    "Región Patagonia": "ipc_ng_patagonia",
}
MANIFEST = ROOT / "datos" / "originales" / "manifiesto.json"
INPUTS = (
    ("sh_ipc_09_26.xls", "Índices IPC Cobertura Nacional", {"Total nacional": "ipc_ng_nacional"}),
    ("sh_ipc_aperturas.xls", "Índices aperturas", REGIONS),
)


def month_number(value: str) -> int:
    return int(value[:4]) * 12 + int(value[5:7]) - 1


def extract(path: Path, sheet_name: str, mapping: dict[str, str]) -> dict:
    book = xlrd.open_workbook(path)
    sheet = book.sheet_by_name(sheet_name)
    result = {}
    for row in range(sheet.nrows):
        region = str(sheet.cell_value(row, 0)).strip()
        if region not in mapping:
            continue
        candidates = [r for r in range(row + 1, min(row + 8, sheet.nrows))
                      if str(sheet.cell_value(r, 0)).strip() == "Nivel general"]
        if len(candidates) != 1:
            raise ValueError(f"No se identifica Nivel general de {region}")
        values_row = candidates[0]
        observations, notes = [], []
        for column in range(1, sheet.ncols):
            cell = sheet.cell(row, column)
            if cell.ctype == xlrd.XL_CELL_EMPTY:
                continue
            if cell.ctype != xlrd.XL_CELL_DATE:
                raise ValueError(f"Encabezado temporal inesperado: {region}, columna {column}")
            date = xlrd.xldate_as_datetime(cell.value, book.datemode)
            if date.day != 1:
                notes.append(f"Encabezado {date:%Y-%m-%d} interpretado como período mensual {date:%Y-%m}")
            value_cell = sheet.cell(values_row, column)
            if value_cell.ctype != xlrd.XL_CELL_NUMBER:
                raise ValueError(f"Valor no numérico en {region}, {date:%Y-%m}")
            value = value_cell.value
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Un índice IPC debe ser finito y positivo")
            observations.append({"date": date.strftime("%Y-%m-01"), "value": value})
        dates = [o["date"] for o in observations]
        if not dates or len(set(dates)) != len(dates):
            raise ValueError("Serie vacía o con períodos repetidos")
        if any(month_number(b) - month_number(a) != 1 for a, b in zip(dates, dates[1:])):
            raise ValueError("Hay saltos o desorden en los períodos del índice")
        if dates[0] != "2016-12-01" or observations[0]["value"] != 100:
            raise ValueError("La base de referencia del índice cambió")
        result[mapping[region]] = {"observations": observations, "notes": notes, "sheet": sheet_name,
                                   "row": values_row + 1, "file": path.name}
    if set(result) != set(mapping.values()):
        raise ValueError("Faltan regiones esperadas en el archivo")
    return result


def read_manifest(path: Path = MANIFEST) -> dict[str, str]:
    """Fecha de ultima modificacion HTTP, por SHA-256 (ISO 8601 en UTC).

    Sale del encabezado Last-Modified que INDEC manda con el archivo. Va por hash y no
    por nombre porque sh_ipc_aperturas.xls conserva el nombre en cada publicación.
    No prueba la fecha oficial de publicacion.
    """
    if not path.is_file():
        return {}
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("version") != 1 or not isinstance(payload.get("archivos"), dict):
        raise ValueError("Formato de manifiesto no compatible")
    published = {}
    for sha256, entry in payload["archivos"].items():
        try:
            moment = datetime.fromisoformat(entry["http_last_modified_at"])
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"Fecha de publicación inválida en el manifiesto para {sha256[:12]}") from None
        if moment.tzinfo is None:
            raise ValueError(f"La fecha de publicación de {sha256[:12]} debe llevar zona horaria")
        published[sha256] = moment.astimezone(timezone.utc).isoformat()
    return published


def check_coverage(loaded: dict) -> None:
    """Todas las series deben terminar el mismo mes.

    El nombre sh_ipc_MM_AA.xls lleva el mes de publicación, no el del dato, y las
    aperturas se pisan en cada publicación: un nacional viejo junto a unas
    aperturas nuevas deja al nacional un mes atrás sin que ninguna otra
    validación lo note.
    """
    ends = {series_id: data["observations"][-1]["date"] for series_id, data in loaded.items()}
    if len(set(ends.values())) > 1:
        detail = ", ".join(f"{series_id}: {end[:7]}" for series_id, end in sorted(ends.items()))
        raise ValueError(
            "Las series no terminan el mismo mes (" + detail + "). Revisar que sh_ipc_MM_AA.xls "
            "sea el último publicado y que las aperturas sean de esa misma publicación."
        )


def build(top_manifest: Path = top_provincial.MANIFEST, ipc_candidate: Path | None = None) -> dict:
    inputs, loaded, last_modified = [], {}, read_manifest()
    metadata = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.is_file() else {}
    captured_by_hash = {sha: entry["retrieved_at"] for sha, entry in metadata.get("archivos", {}).items()
                        if entry.get("retrieved_at")}
    if ipc_candidate:
        if __package__:
            from . import ipc_indec
        else:
            import ipc_indec
        candidate_inputs, loaded = ipc_indec.load_candidate(ipc_candidate)
        for entry in candidate_inputs:
            # El contrato del piloto usa rutas relativas a datos/originales.
            relative = (ipc_candidate.parent / entry["file"]).resolve().relative_to(
                (ROOT / "datos/originales").resolve()).as_posix()
            inputs.append({**entry, "file": relative})
            for data in loaded.values():
                if data["file"] == entry["file"]:
                    data["file"] = relative
    for filename, sheet, mapping in (() if ipc_candidate else INPUTS):
        path = ROOT / "datos" / "originales" / filename
        sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
        retrieved = (datetime.fromisoformat(captured_by_hash[sha256]) if sha256 in captured_by_hash
                     else datetime.fromtimestamp(path.stat().st_mtime, timezone.utc))
        if retrieved.tzinfo is None:
            raise ValueError(f"{filename} tiene fecha de captura sin zona horaria")
        http_last_modified_at = last_modified.get(sha256)
        if http_last_modified_at and datetime.fromisoformat(http_last_modified_at) > retrieved:
            raise ValueError(f"{filename} tiene Last-Modified posterior a la descarga: revisar el manifiesto")
        inputs.append({
            "file": filename,
            "url": f"https://www.indec.gob.ar/ftp/cuadros/economia/{filename}",
            "sha256": sha256,
            "retrieved_at": retrieved.isoformat(),
            "published_at": None,
            "http_last_modified_at": http_last_modified_at,
        })
        loaded.update(extract(path, sheet, mapping))
    check_coverage(loaded)
    top_originals, top_data = top_provincial.load(top_manifest)
    inputs.extend(top_originals)
    loaded["top_mensual_cordoba"] = top_data
    with (ROOT / "catalogo" / "series.csv").open(encoding="utf-8", newline="") as file:
        catalogue = list(csv.DictReader(file))
    with (ROOT / "catalogo" / "fuentes.csv").open(encoding="utf-8", newline="") as file:
        sources = {s["fuente_id"]: s for s in csv.DictReader(file)}
    ids = [item["serie_id"] for item in catalogue]
    if len(ids) != 100 or len(set(ids)) != 100 or not set(loaded).issubset(ids):
        raise ValueError("El catálogo debe contener 100 IDs únicos e incluir las siete series IPC")
    fingerprint = json.dumps({"inputs": inputs, "catalogue": catalogue, "loaded": loaded, "version": VERSION},
                             ensure_ascii=False, sort_keys=True).encode()
    release = "economia-piloto-" + hashlib.sha256(fingerprint).hexdigest()[:12]
    series = []
    for item in catalogue:
        data = loaded.get(item["serie_id"])
        observations = data["observations"] if data else []
        originals = data.get("originals", []) if data else []
        if data and not originals:
            originals = [next(source for source in inputs if source["file"] == data["file"])]
        original = originals[-1] if originals else None
        series.append({
            "id": item["serie_id"], "name": item["nombre"], "topic": item["tema"],
            "level": item["nivel"], "territory": item["territorio"],
            "classification": item["clasificacion_geografica"],
            "frequency": item["frecuencia"], "unit": item["unidad"], "basis": item["base_o_ajuste"],
            "source_id": item["fuente_id"], "source": sources[item["fuente_id"]]["productor"],
            "source_url": item["url_publicacion"], "pending": "Revisión humana integral pendiente" if data else item["pendientes"],
            "available": bool(data), "status": "Piloto local" if data else "Sin cargar",
            "start": observations[0]["date"] if data else None,
            "end": observations[-1]["date"] if data else None,
            "count": len(observations), "original": original, "originals": originals,
            "sheet": data["sheet"] if data else None, "source_row": data["row"] if data else None,
            "normalization_notes": data["notes"] if data else [], "observations": observations,
        })
    return {"schema_version": VERSION, "release_id": release, "status": "Piloto local",
            "inputs": inputs, "series": series}


def write_bundle(bundle: dict, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / "catalogo.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(target)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chartbay", type=Path, help="Carpeta raíz de ChartBay para copiar el piloto")
    parser.add_argument("--check-top-candidate", type=Path,
                        help="Valida un manifiesto TOP candidato sin escribir la instantanea")
    ipc_options = parser.add_mutually_exclusive_group()
    ipc_options.add_argument("--check-ipc-candidate", type=Path,
                             help="Valida una candidata IPC y el bundle completo sin escribir")
    ipc_options.add_argument("--promote-ipc-candidate", type=Path,
                             help="Promoción manual explícita al piloto local, con respaldo previo")
    args = parser.parse_args()
    checking = args.check_top_candidate or args.check_ipc_candidate
    if checking and args.chartbay:
        parser.error("No se puede copiar a ChartBay mientras se valida un candidato")
    if args.check_top_candidate and (args.check_ipc_candidate or args.promote_ipc_candidate):
        parser.error("Revisar candidatas TOP e IPC en operaciones separadas")
    if args.chartbay and not (args.chartbay / "web" / "app.py").is_file():
        parser.error("La carpeta indicada no contiene web/app.py")
    bundle = build(args.check_top_candidate or top_provincial.MANIFEST,
                   args.check_ipc_candidate or args.promote_ipc_candidate)
    if args.promote_ipc_candidate:
        if __package__:
            from .recolectar_ipc import preserve
        else:
            from recolectar_ipc import preserve
        preserve(ROOT / "datos/piloto/respaldos", "catalogo", "json",
                 (ROOT / "datos/piloto/catalogo.json").read_bytes())
    if not checking:
        write_bundle(bundle, ROOT / "datos" / "piloto")
    if args.chartbay:
        write_bundle(bundle, args.chartbay / "datasets" / "economia")
    available = [s for s in bundle["series"] if s["available"]]
    undated = [source["file"] for source in bundle["inputs"] if source["published_at"] is None]
    print(json.dumps({"release": bundle["release_id"], "without_official_published_at": undated, "catalogue": len(bundle["series"]),
                      "available": len(available), "observations": sum(s["count"] for s in available),
                      "coverage": {s["id"]: [s["start"], s["end"]] for s in available}}, ensure_ascii=False))
