"""Importa las 24 jurisdicciones TOP oficiales al catálogo local, sin IA ni limpieza.

Conserva datos/piloto/catalogo.json: el cargador Supabase sigue usando ese piloto
auditado. Esta ampliación se guarda en datos/importadas y se puede copiar a ChartBay.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
from pathlib import Path

if __package__:
    from . import preparar_piloto, recolectar_top, top_provincial
else:
    import preparar_piloto
    import recolectar_top
    import top_provincial

ROOT = preparar_piloto.ROOT
DESTINATION = ROOT / "datos/importadas"
JURISDICTIONS = {
    "buenos_aires": "Buenos Aires", "caba": "C.A.B.A.", "catamarca": "Catamarca",
    "chaco": "Chaco", "chubut": "Chubut", "cordoba": "Córdoba",
    "corrientes": "Corrientes", "entre_rios": "Entre Ríos", "formosa": "Formosa",
    "jujuy": "Jujuy", "la_pampa": "La Pampa", "la_rioja": "La Rioja",
    "mendoza": "Mendoza", "misiones": "Misiones", "neuquen": "Neuquén",
    "rio_negro": "Río Negro", "salta": "Salta", "san_juan": "San Juan",
    "san_luis": "San Luis", "santa_cruz": "Santa Cruz", "santa_fe": "Santa Fe",
    "santiago_del_estero": "Santiago del Estero", "tierra_del_fuego": "Tierra del Fuego",
    "tucuman": "Tucumán",
}


def build(manifest: Path) -> dict:
    # El piloto anterior permanece reproducible, incluidas sus 851 observaciones.
    bundle = preparar_piloto.build()
    by_id = {series["id"]: series for series in bundle["series"]}
    inputs = {entry["sha256"]: entry for entry in bundle["inputs"]
              if entry["file"].startswith("sh_ipc_")}
    for suffix, jurisdiction in JURISDICTIONS.items():
        originals, data = top_provincial.load(manifest, jurisdiction, allow_gaps=True)
        series = by_id[f"top_mensual_{suffix}"]
        observed = {item["date"] for item in data["observations"]}
        start, end = data["observations"][0]["date"], data["observations"][-1]["date"]
        missing = [f"{year}-{month:02d}-01"
                   for year in range(int(start[:4]), int(end[:4]) + 1)
                   for month in range(1, 13)
                   if start <= f"{year}-{month:02d}-01" <= end
                   and f"{year}-{month:02d}-01" not in observed]
        notes = list(data["notes"])
        notes[1] = ("Los ceros y celdas vacías de la fila TOTAL se conservan como faltantes, "
                    "sin imputar recaudación nula; los originales preservan la representación exacta.")
        notes.append("Las potestades tributarias difieren por jurisdicción; revisar antes de comparar.")
        if missing:
            notes.append("Períodos sin dato en el original, sin completar: " + ", ".join(missing))
        series.update({
            "unit": "Millones de ARS corrientes",
            "basis": "Total mensual informado por el organismo recaudador; puede incluir recursos no tributarios",
            "pending": "Revisión humana integral pendiente", "available": True,
            "status": "Piloto local", "start": start, "end": end,
            "count": len(data["observations"]), "original": originals[-1], "originals": originals,
            "sheet": data["sheet"], "source_row": data["row"],
            "normalization_notes": notes, "observations": data["observations"],
            "missing_periods": missing,
        })
        for original in originals:
            # La fila pertenece a cada serie, no al inventario común de archivos.
            inputs[original["sha256"]] = {key: value for key, value in original.items()
                                         if key not in ("sheet", "source_row")}
    bundle["inputs"] = list(inputs.values())
    bundle.pop("release_id")
    fingerprint = json.dumps(bundle, ensure_ascii=False, sort_keys=True).encode()
    bundle["release_id"] = "economia-importacion-" + hashlib.sha256(fingerprint).hexdigest()[:12]
    return bundle


def write_text(path: Path, content: str) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def write_exports(bundle: dict, destination: Path = DESTINATION) -> None:
    preparar_piloto.write_bundle(bundle, destination)
    output = io.StringIO(newline="")
    fields = ("serie_id", "territorio", "periodo", "valor", "unidad", "archivo", "url", "sha256", "hoja", "fila", "celda")
    writer = csv.DictWriter(output, fieldnames=fields)
    writer.writeheader()
    series = [s for s in bundle["series"] if s["id"].startswith("top_mensual_")]
    for item in series:
        for observation in item["observations"]:
            year = observation["date"][:4]
            original = next(source for source in item["originals"] if year in source["file"])
            column = chr(ord("B") + int(observation["date"][5:7]))
            writer.writerow(dict(zip(fields, (
                item["id"], item["territory"], observation["date"], observation["value"],
                item["unit"], original["file"], original["url"], original["sha256"],
                original["sheet"], original["source_row"], f"{column}{original['source_row']}",
            ))))
    write_text(destination / "top_mensual.csv", output.getvalue())
    lines = ["# Importación directa TOP", "", f"Versión: `{bundle['release_id']}`.", "",
             "Fuente: [Recursos Tributarios de Origen Provincial](" + recolectar_top.PAGE + ").", "",
             "24 jurisdicciones, en millones de ARS corrientes. Se importan los valores numéricos de la hoja TOTAL, "
             "sin redondear, corregir ni imputar. Los ceros y vacíos se omiten de las observaciones; "
             "se conservan en los Excel originales y se documentan los huecos interiores. "
             "Revisar su significado antes de usar esas ausencias en un análisis.", "",
             "Los meses disponibles varían por provincia. El total nacional de la planilla no se importa "
             "porque reúne jurisdicciones con distinta cobertura. Las potestades tributarias provinciales difieren.", "",
             "| Jurisdicción | Inicio | Último mes | Observaciones | Huecos interiores |",
             "| --- | --- | --- | ---: | --- |"]
    for item in series:
        lines.append(f"| {item['territory']} | {item['start'][:7]} | {item['end'][:7]} | {item['count']} | "
                     + (", ".join(date[:7] for date in item["missing_periods"]) or "—") + " |")
    lines += ["", f"Observaciones TOP: {sum(s['count'] for s in series)}. "
              f"Series disponibles con IPC: {sum(s['available'] for s in bundle['series'])}.", "",
              "Las siete series IPC mantienen los originales del piloto y llegan a agosto de 2026; "
              "esta importación no actualiza IPC. El piloto auditado de ocho series permanece en datos/piloto.", "",
              "Esta carga local no publica releases ni escribe en Supabase. Revisión metodológica, "
              "licencias, limpieza y agente quedan pendientes.", ""]
    write_text(destination / "README.md", "\n".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--descargar", action="store_true", help="Descargar de nuevo los TOP oficiales")
    source.add_argument("--manifiesto", type=Path, help="Reutilizar una descarga conservada")
    parser.add_argument("--chartbay", type=Path, help="Copiar el catálogo ampliado al piloto local de ChartBay")
    args = parser.parse_args()
    if args.chartbay and not (args.chartbay / "web/app.py").is_file():
        parser.error("La carpeta ChartBay no contiene web/app.py")
    manifest = recolectar_top.collect() if args.descargar else args.manifiesto
    bundle = build(manifest)
    write_exports(bundle)
    if args.chartbay:
        preparar_piloto.write_bundle(bundle, args.chartbay / "datasets/economia")
    print(json.dumps({"release": bundle["release_id"], "manifest": str(manifest),
                      "available": sum(s["available"] for s in bundle["series"]),
                      "observations": sum(s["count"] for s in bundle["series"]),
                      "destination": str(DESTINATION), "chartbay": str(args.chartbay) if args.chartbay else None,
                      "publicados": 0}, ensure_ascii=False))


if __name__ == "__main__":
    main()
