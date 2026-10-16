"""Carga reproducible del piloto auditado como candidatos privados en Supabase.

Este programa no publica: no escribe en ``release`` ni en ``observacion``. Sube
los cinco originales por hash a Storage y deja dos candidatos abiertos (IPC y
TOP) en el esquema privado existente de ChartBay.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

if __package__:
    from . import preparar_piloto
else:
    import preparar_piloto


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / "datos" / "piloto" / "catalogo.json"
ORIGINALS = ROOT / "datos" / "originales"
EXPECTED_SERIES = 8
EXPECTED_OBSERVATIONS = 851
BUCKET_DEFAULT = "economia-crudos"
SCHEMA_DEFAULT = "economia"
IMPORT_KIND = "importacion_piloto_auditado"


class LoadError(RuntimeError):
    """Error seguro para mostrar en la consola sin incluir credenciales."""


@dataclass(frozen=True)
class Original:
    key: str
    file: str
    path: Path
    url: str
    sha256: str
    size: int
    storage_path: str
    retrieved_at: str
    http_last_modified_at: str | None
    published_at: str | None
    source_id: str


@dataclass(frozen=True)
class SourceLoad:
    source_id: str
    source_name: str
    source_url: str
    series: tuple[dict[str, Any], ...]
    originals: tuple[Original, ...]
    findings: tuple[dict[str, Any], ...]

    @property
    def observation_count(self) -> int:
        return sum(len(item["observations"]) for item in self.series)


@dataclass(frozen=True)
class Pilot:
    pilot_id: str
    schema_version: int
    sources: tuple[SourceLoad, ...]
    originals: tuple[Original, ...]
    controls: tuple[dict[str, str], ...]

    @property
    def observation_count(self) -> int:
        return sum(source.observation_count for source in self.sources)


def _month_number(value: str) -> int:
    return int(value[:4]) * 12 + int(value[5:7]) - 1


def _decimal(value: Any) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite():
        raise LoadError(f"Valor no finito en el piloto: {value!r}")
    return result


def _source_catalogue() -> dict[str, dict[str, str]]:
    with (ROOT / "catalogo" / "fuentes.csv").open(encoding="utf-8", newline="") as handle:
        return {row["fuente_id"]: row for row in csv.DictReader(handle)}


def _finding_rows(series: Iterable[dict[str, Any]]) -> tuple[dict[str, Any], ...]:
    """Convierte alertas determinísticas en hallazgos; nunca corrige valores."""
    findings: list[dict[str, Any]] = []
    for item in series:
        previous: dict[str, Any] | None = None
        for observation in item["observations"]:
            if previous is not None:
                change = (_decimal(observation["value"]) / _decimal(previous["value"]) - 1) * 100
                if abs(change) > 20:
                    findings.append({
                        "series_id": item["id"],
                        "period": observation["date"],
                        "rule": "salto_mensual",
                        "severity": "media",
                        "detail": (
                            f"{item['id']} varió {change.quantize(Decimal('0.01'))}% en "
                            f"{observation['date']}; supera el umbral de 20%."
                        ),
                    })
            previous = observation
        for note in item.get("normalization_notes", []):
            findings.append({
                "series_id": item["id"],
                "period": None,
                "rule": "fecha_normalizada" if "Encabezado" in note else "nota_procedencia",
                "severity": "baja",
                "detail": f"{item['id']}: {note}",
            })
    return tuple(findings)


def _validate_series(series: list[dict[str, Any]]) -> tuple[dict[str, str], ...]:
    seen: set[tuple[str, str]] = set()
    for item in series:
        observations = item["observations"]
        if not observations:
            raise LoadError(f"La serie {item['id']} está vacía")
        dates = [entry["date"] for entry in observations]
        if any(not re.fullmatch(r"\d{4}-\d{2}-01", value) for value in dates):
            raise LoadError(f"{item['id']} tiene un período que no empieza el día 1")
        if any(_month_number(right) - _month_number(left) != 1 for left, right in zip(dates, dates[1:])):
            raise LoadError(f"{item['id']} tiene meses ausentes, repetidos o desordenados")
        for entry in observations:
            key = (item["id"], entry["date"])
            if key in seen:
                raise LoadError(f"Observación repetida: {item['id']} {entry['date']}")
            seen.add(key)
            if _decimal(entry["value"]) <= 0:
                raise LoadError(f"Valor no positivo: {item['id']} {entry['date']}")
    return (
        {"regla": "series_esperadas", "resultado": "ok", "detalle": f"{len(series)} series únicas"},
        {"regla": "observaciones_esperadas", "resultado": "ok", "detalle": f"{len(seen)} observaciones únicas"},
        {"regla": "continuidad_mensual", "resultado": "ok", "detalle": "Todos los períodos son mensuales y consecutivos"},
        {"regla": "valores_validos", "resultado": "ok", "detalle": "Todos los valores son finitos y positivos"},
    )


def prepare_pilot() -> Pilot:
    """Reconstruye el piloto desde los originales y exige la instantánea auditada."""
    built = preparar_piloto.build()
    stored = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
    if built != stored:
        raise LoadError(
            "datos/piloto/catalogo.json no coincide con los originales actuales; "
            "ejecutar scripts/preparar_piloto.py y auditar el cambio antes de cargar"
        )

    series = [item for item in built["series"] if item["available"]]
    controls = list(_validate_series(series))
    if len(series) != EXPECTED_SERIES or sum(item["count"] for item in series) != EXPECTED_OBSERVATIONS:
        raise LoadError(
            f"El piloto dejó de tener {EXPECTED_SERIES} series y {EXPECTED_OBSERVATIONS} observaciones"
        )

    sources_by_sha: dict[str, set[str]] = {}
    for item in series:
        if item["count"] != len(item["observations"]):
            raise LoadError(f"Conteo incoherente en {item['id']}")
        for original in item["originals"]:
            sources_by_sha.setdefault(original["sha256"], set()).add(item["source_id"])

    originals: list[Original] = []
    used_keys: set[str] = set()
    for entry in built["inputs"]:
        path = ORIGINALS / entry["file"]
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != entry["sha256"]:
            raise LoadError(f"SHA-256 distinto para {entry['file']}")
        source_ids = sources_by_sha.get(digest, set())
        if len(source_ids) != 1:
            raise LoadError(f"No se puede asignar {entry['file']} a una única fuente")
        source_id = next(iter(source_ids))
        stem = "nacional" if entry["file"].startswith("sh_ipc_09") else (
            "aperturas" if entry["file"].startswith("sh_ipc_aperturas") else f"top_{entry['file'][12:16]}"
        )
        key = stem
        suffix = 2
        while key in used_keys:
            key = f"{stem}_{suffix}"
            suffix += 1
        used_keys.add(key)
        extension = path.suffix.lower()
        originals.append(Original(
            key=key,
            file=entry["file"],
            path=path,
            url=entry["url"],
            sha256=digest,
            size=path.stat().st_size,
            storage_path=f"{digest[:2]}/{digest}{extension}",
            retrieved_at=entry["retrieved_at"],
            http_last_modified_at=entry.get("http_last_modified_at"),
            published_at=entry.get("published_at"),
            source_id=source_id,
        ))
    if len(originals) != 5:
        raise LoadError(f"El piloto auditado debe tener 5 originales, no {len(originals)}")
    controls.append({"regla": "sha256_originales", "resultado": "ok", "detalle": "5/5 archivos coinciden byte por byte"})
    controls.append({"regla": "instantanea_reproducida", "resultado": "ok", "detalle": built["release_id"]})

    catalogue = _source_catalogue()
    grouped: list[SourceLoad] = []
    for source_id in sorted({item["source_id"] for item in series}):
        source_series = tuple(item for item in series if item["source_id"] == source_id)
        source_originals = tuple(item for item in originals if item.source_id == source_id)
        meta = catalogue[source_id]
        grouped.append(SourceLoad(
            source_id=source_id,
            source_name=meta["productor"],
            source_url=meta["url_publicacion"],
            series=source_series,
            originals=source_originals,
            findings=_finding_rows(source_series),
        ))

    return Pilot(
        pilot_id=built["release_id"],
        schema_version=built["schema_version"],
        sources=tuple(grouped),
        originals=tuple(originals),
        controls=tuple(controls),
    )


def _storage_url(base: str, kind: str, bucket: str, path: str) -> str:
    encoded_path = "/".join(urllib.parse.quote(part, safe="") for part in path.split("/"))
    return f"{base.rstrip('/')}/storage/v1/object/{kind}/{urllib.parse.quote(bucket, safe='')}/{encoded_path}"


def _read_response(error: urllib.error.HTTPError) -> str:
    try:
        return error.read(2048).decode("utf-8", "replace")
    except Exception:
        return str(error.reason)


def upload_original(original: Original, supabase_url: str, service_key: str, bucket: str) -> str:
    """Sube sin sobrescribir; si ya existe, descarga y comprueba el hash."""
    content = original.path.read_bytes()
    content_type = (
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        if original.path.suffix.lower() == ".xlsx" else "application/vnd.ms-excel"
    )
    headers = {
        "Authorization": f"Bearer {service_key}",
        "apikey": service_key,
        "Content-Type": content_type,
        "x-upsert": "false",
    }
    request = urllib.request.Request(
        _storage_url(supabase_url, "", bucket, original.storage_path).replace("/object//", "/object/"),
        data=content,
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60):
            return "subido"
    except urllib.error.HTTPError as error:
        detail = _read_response(error)
        if error.code not in (400, 409) or not re.search(r"exist|duplicate|already", detail, re.IGNORECASE):
            raise LoadError(f"Storage rechazó {original.file} (HTTP {error.code}): {detail}") from None

    verify = urllib.request.Request(
        _storage_url(supabase_url, "authenticated", bucket, original.storage_path),
        headers={"Authorization": f"Bearer {service_key}", "apikey": service_key},
        method="GET",
    )
    try:
        with urllib.request.urlopen(verify, timeout=60) as response:
            stored = response.read()
    except urllib.error.HTTPError as error:
        raise LoadError(f"No se pudo verificar {original.file} ya existente (HTTP {error.code})") from None
    if len(stored) != original.size or hashlib.sha256(stored).hexdigest() != original.sha256:
        raise LoadError(f"El objeto existente {original.storage_path} no coincide con el original local")
    return "existente_verificado"


def _candidate_rows(source: SourceLoad) -> dict[tuple[str, date], Decimal]:
    return {
        (item["id"], date.fromisoformat(observation["date"])): _decimal(observation["value"])
        for item in source.series for observation in item["observations"]
    }


def _candidate_matches(conn: Any, candidate_id: int, source: SourceLoad) -> bool:
    expected = _candidate_rows(source)
    rows = conn.execute(
        "SELECT serie_id, periodo, valor FROM observacion_candidata WHERE candidato_id = %s",
        (candidate_id,),
    ).fetchall()
    actual = {(series_id, period): value for series_id, period, value in rows}
    return actual == expected


def _detail_series(source: SourceLoad) -> dict[str, Any]:
    by_sha = {item.sha256: item for item in source.originals}
    result: dict[str, Any] = {}
    for item in source.series:
        refs = [by_sha[entry["sha256"]] for entry in item["originals"]]
        result[item["id"]] = {
            "archivo": refs[-1].key,
            "archivos": [ref.key for ref in refs],
            "hoja": item["sheet"],
            "fila_origen": item["source_row"],
            "filas_por_archivo": {
                ref.key: entry.get("source_row") for ref, entry in zip(refs, item["originals"])
            },
            "notas": item.get("normalization_notes", []),
        }
    return result


def _summary(pilot: Pilot, source: SourceLoad, candidate_id: int | None, reused: bool) -> dict[str, Any]:
    return {
        "tipo": IMPORT_KIND,
        "piloto_id": pilot.pilot_id,
        "schema_version_piloto": pilot.schema_version,
        "fuente_id": source.source_id,
        "candidato_id" if not reused else "candidato_reutilizado": candidate_id,
        "series": len(source.series),
        "observaciones": source.observation_count,
        "archivos": [{
            "clave": item.key,
            "file": item.file,
            "url": item.url,
            "sha256": item.sha256,
            "bytes": item.size,
            "ruta_crudo": item.storage_path,
            "retrieved_at": item.retrieved_at,
            "http_last_modified_at": item.http_last_modified_at,
            "published_at": item.published_at,
        } for item in source.originals],
        "detalle_series": _detail_series(source),
        "controles": list(pilot.controls),
        "hallazgos": {
            severity: sum(item["severity"] == severity for item in source.findings)
            for severity in ("alta", "media", "baja")
        },
        "requiere_revision_humana": True,
        "pendientes_humanos": [
            "Revisión metodológica integral",
            "Condiciones de reutilización y atribución",
            "Decisión explícita de publicación",
        ],
        "estado_publicacion": "candidato_no_publicado",
        "auditoria_local": "datos/AUDITORIA_8_SERIES.md",
    }


def _register_downloads(conn: Any, run_id: int, source: SourceLoad) -> None:
    for original in source.originals:
        known = conn.execute(
            "SELECT EXISTS (SELECT 1 FROM descarga WHERE url = %s AND sha256 = %s AND estado IN ('nueva', 'identica'))",
            (original.url, original.sha256),
        ).fetchone()[0]
        download_id = conn.execute(
            "INSERT INTO descarga (fuente_id, url, sha256, bytes, ruta_crudo, descargada_en, publicada_en, estado) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (source.source_id, original.url, original.sha256, original.size, original.storage_path,
             original.retrieved_at, original.http_last_modified_at, "identica" if known else "nueva"),
        ).fetchone()[0]
        conn.execute(
            "INSERT INTO corrida_descarga (corrida_id, descarga_id) VALUES (%s, %s)",
            (run_id, download_id),
        )


def _ensure_catalogue(conn: Any, source: SourceLoad) -> None:
    conn.execute(
        "INSERT INTO fuente (id, nombre, url_base) VALUES (%s, %s, %s) ON CONFLICT (id) DO NOTHING",
        (source.source_id, source.source_name, source.source_url),
    )
    for item in source.series:
        conn.execute(
            "INSERT INTO serie (id, fuente_id, nombre, tema, nivel, territorio, clasificacion, frecuencia, unidad, base, "
            "hoja_origen, fila_origen) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (id) DO NOTHING",
            (item["id"], source.source_id, item["name"], item["topic"], item["level"], item["territory"],
             item["classification"], item["frequency"], item["unit"], item["basis"], item["sheet"], item["source_row"]),
        )
    wrong = conn.execute(
        "SELECT id, fuente_id FROM serie WHERE id = ANY(%s) AND fuente_id <> %s",
        ([item["id"] for item in source.series], source.source_id),
    ).fetchall()
    if wrong:
        raise LoadError(f"Hay series asociadas a otra fuente: {wrong}")


def _existing_import(conn: Any, pilot: Pilot, source: SourceLoad) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT id, estado, resumen FROM corrida WHERE fuente_id = %s AND resumen->>'tipo' = %s "
        "AND resumen->>'piloto_id' = %s ORDER BY id DESC LIMIT 1",
        (source.source_id, IMPORT_KIND, pilot.pilot_id),
    ).fetchone()
    if not row:
        return None
    run_id, run_state, summary = row
    candidate_id = summary.get("candidato_id") or summary.get("candidato_reutilizado")
    if not candidate_id or not _candidate_matches(conn, int(candidate_id), source):
        raise LoadError(f"La importación previa de {source.source_id} no coincide con el piloto")
    candidate_state = conn.execute("SELECT estado FROM candidato WHERE id = %s", (candidate_id,)).fetchone()
    if not candidate_state:
        raise LoadError(f"Falta el candidato {candidate_id} referido por la importación previa")
    return {
        "fuente_id": source.source_id,
        "corrida_id": run_id,
        "estado_corrida": run_state,
        "candidato_id": int(candidate_id),
        "estado_candidato": candidate_state[0],
        "resultado": "ya_registrado",
        "observaciones": source.observation_count,
    }


def _load_source(conn: Any, pilot: Pilot, source: SourceLoad) -> dict[str, Any]:
    previous = _existing_import(conn, pilot, source)
    if previous:
        return previous

    _ensure_catalogue(conn, source)
    open_candidates = conn.execute(
        "SELECT c.id FROM candidato c JOIN corrida co ON co.id = c.corrida_id "
        "WHERE co.fuente_id = %s AND c.estado = 'abierto' ORDER BY c.id DESC",
        (source.source_id,),
    ).fetchall()
    matching = [candidate_id for (candidate_id,) in open_candidates if _candidate_matches(conn, candidate_id, source)]
    if open_candidates and len(matching) != len(open_candidates):
        raise LoadError(
            f"{source.source_id} ya tiene un candidato abierto distinto; se conserva y la importación se cancela"
        )

    run_id = conn.execute(
        "INSERT INTO corrida (fuente_id, estado) VALUES (%s, 'en_curso') RETURNING id",
        (source.source_id,),
    ).fetchone()[0]
    _register_downloads(conn, run_id, source)

    if matching:
        candidate_id = matching[0]
        summary = _summary(pilot, source, candidate_id, reused=True)
        conn.execute(
            "UPDATE corrida SET estado = 'sin_cambios', terminada_en = now(), resumen = %s::jsonb WHERE id = %s",
            (json.dumps(summary, ensure_ascii=False), run_id),
        )
        return {
            "fuente_id": source.source_id,
            "corrida_id": run_id,
            "estado_corrida": "sin_cambios",
            "candidato_id": candidate_id,
            "estado_candidato": "abierto",
            "resultado": "candidato_identico_reutilizado",
            "observaciones": source.observation_count,
        }

    candidate_id = conn.execute(
        "INSERT INTO candidato (corrida_id) VALUES (%s) RETURNING id", (run_id,)
    ).fetchone()[0]
    rows = [
        (candidate_id, item["id"], observation["date"], str(_decimal(observation["value"])))
        for item in source.series for observation in item["observations"]
    ]
    with conn.cursor() as cursor:
        cursor.executemany(
            "INSERT INTO observacion_candidata (candidato_id, serie_id, periodo, valor) VALUES (%s, %s, %s, %s)",
            rows,
        )
        cursor.executemany(
            "INSERT INTO hallazgo (corrida_id, serie_id, periodo, regla, severidad, detalle) "
            "VALUES (%s, %s, %s, %s, %s, %s)",
            [(run_id, item["series_id"], item["period"], item["rule"], item["severity"], item["detail"])
             for item in source.findings],
        )
    summary = _summary(pilot, source, candidate_id, reused=False)
    conn.execute(
        "UPDATE corrida SET estado = 'con_candidato', terminada_en = now(), resumen = %s::jsonb WHERE id = %s",
        (json.dumps(summary, ensure_ascii=False), run_id),
    )
    if conn.execute("SELECT EXISTS (SELECT 1 FROM release WHERE candidato_id = %s)", (candidate_id,)).fetchone()[0]:
        raise LoadError("Invariante rota: la carga candidata creó un release")
    return {
        "fuente_id": source.source_id,
        "corrida_id": run_id,
        "estado_corrida": "con_candidato",
        "candidato_id": candidate_id,
        "estado_candidato": "abierto",
        "resultado": "candidato_creado",
        "observaciones": source.observation_count,
        "hallazgos": len(source.findings),
    }


def load_database(pilot: Pilot, database_url: str, schema: str) -> list[dict[str, Any]]:
    if not re.fullmatch(r"[a-z_][a-z0-9_]*", schema):
        raise LoadError("DATOS_SCHEMA no es un identificador PostgreSQL válido")
    try:
        import psycopg
        from psycopg import sql
    except ImportError:
        raise LoadError("Falta psycopg: instalar requirements.txt") from None

    try:
        with psycopg.connect(database_url) as conn:
            with conn.transaction():
                conn.execute(sql.SQL("SET LOCAL search_path TO {}, pg_temp").format(sql.Identifier(schema)))
                required = ("fuente", "serie", "descarga", "corrida", "corrida_descarga", "candidato",
                            "observacion_candidata", "hallazgo", "release", "observacion")
                missing = [name for name in required if conn.execute("SELECT to_regclass(%s)", (f"{schema}.{name}",)).fetchone()[0] is None]
                if missing:
                    raise LoadError(f"El esquema {schema} no tiene las tablas requeridas: {', '.join(missing)}")
                conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (f"{IMPORT_KIND}:{pilot.pilot_id}",))
                results = [_load_source(conn, pilot, source) for source in pilot.sources]
                loaded = sum(item["observaciones"] for item in results)
                if loaded != EXPECTED_OBSERVATIONS:
                    raise LoadError(f"La transacción no cubre las {EXPECTED_OBSERVATIONS} observaciones")
                return results
    except LoadError:
        raise
    except Exception as error:
        raise LoadError(f"Falló la transacción PostgreSQL: {type(error).__name__}: {error}") from None


def dry_run_report(pilot: Pilot) -> dict[str, Any]:
    return {
        "modo": "validacion_sin_escrituras",
        "piloto_id": pilot.pilot_id,
        "originales": len(pilot.originals),
        "series": sum(len(source.series) for source in pilot.sources),
        "observaciones": pilot.observation_count,
        "fuentes": [{
            "fuente_id": source.source_id,
            "originales": len(source.originals),
            "series": len(source.series),
            "observaciones": source.observation_count,
            "hallazgos_a_registrar": len(source.findings),
        } for source in pilot.sources],
        "controles": list(pilot.controls),
        "publica": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="reconstruye y valida el piloto sin usar credenciales ni escribir")
    args = parser.parse_args(argv)
    try:
        pilot = prepare_pilot()
        if args.dry_run:
            print(json.dumps(dry_run_report(pilot), ensure_ascii=False, indent=2))
            return 0

        database_url = os.environ.get("DATOS_DATABASE_URL")
        supabase_url = os.environ.get("SUPABASE_URL")
        service_key = os.environ.get("DATOS_CLAVE_SERVIDOR") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        missing = [name for name, value in (
            ("DATOS_DATABASE_URL", database_url), ("SUPABASE_URL", supabase_url),
            ("DATOS_CLAVE_SERVIDOR o SUPABASE_SERVICE_ROLE_KEY", service_key),
        ) if not value]
        if missing:
            raise LoadError("Faltan variables de entorno: " + ", ".join(missing))

        bucket = os.environ.get("DATOS_STORAGE_BUCKET", BUCKET_DEFAULT)
        storage = {item.file: upload_original(item, supabase_url, service_key, bucket) for item in pilot.originals}
        database = load_database(pilot, database_url, os.environ.get("DATOS_SCHEMA", SCHEMA_DEFAULT))
        print(json.dumps({
            "piloto_id": pilot.pilot_id,
            "storage": storage,
            "base": database,
            "observaciones": pilot.observation_count,
            "publicados": 0,
            "mensaje": "Carga candidata completa; requiere revisión humana y publicación explícita.",
        }, ensure_ascii=False, indent=2))
        return 0
    except (LoadError, OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
