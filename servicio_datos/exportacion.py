"""La copia pública de lo aprobado: cada release publicado como un CSV por serie, con su manifiesto, y un catálogo del vigente.

Supabase sigue siendo la fuente de verdad; esto es una copia para consultar y descargar, que va a guardar un repositorio de
GitHub. Solo sale lo publicado: nada de candidatos, hallazgos, decisiones, corridas ni crudo, y tampoco quién aprobó.

- Cada release es una carpeta que no cambia nunca (`releases/<release_id>/`): un CSV por serie (`fecha,valor`) y
  `manifiesto.json` con la fuente, la licencia, de qué archivos salió y el SHA-256 de cada CSV. Antes de escribirla se comprueba
  que lo que se va a exportar da el mismo hash de contenido que se aprobó (`release.hash_contenido`).
- `catalogo.json`, en la raíz, lista los releases exportados y el vigente de cada fuente. Sale solo de los manifiestos que ya
  están escritos y verificados, y se escribe al final: nunca anuncia un release incompleto.
- Una fuente sin licencia y atribución (columnas de `fuente`, que completa una persona después de revisar los términos de la
  fuente) no se exporta.
- Es seguro repetirlo: lo que ya está no se toca (y se verifica), y si una corrida se cortó, la siguiente lo rehace. Lo que no
  pudo salir queda pendiente, se informa y se reintenta en la próxima.

`comprobar` verifica una copia sin la base: cada CSV contra su manifiesto, y el hash de contenido recalculado desde los CSV, así
que cualquiera puede comprobar que la copia es exactamente lo aprobado.

`subir` hace commit de la copia en el repositorio (el de ChartBay, en `datasets/economia/publicado/`) y la sube. Lo corre el flujo
`.github/workflows/exportar-datos.yml`: solo toca esa carpeta, y no sube una copia que no pase la comprobación.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from servicio_datos.publicacion import hash_contenido

VERSION = 1
NOMBRE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,99}$")  # un release_id que puede ser nombre de carpeta
CSV = re.compile(r"^[a-z0-9_]+\.csv$")
ENCABEZADO = "fecha,valor"


class ErrorExportacion(Exception):
    pass


def _sha256(contenido: bytes) -> str:
    return hashlib.sha256(contenido).hexdigest()


def _json(contenido: dict) -> bytes:
    return (json.dumps(contenido, ensure_ascii=False, indent=1) + "\n").encode("utf-8")


def _iso(momento: datetime) -> str:
    return momento.astimezone(timezone.utc).isoformat(timespec="seconds")


def _csv(observaciones: list[tuple[date, Decimal]]) -> bytes:
    return (ENCABEZADO + "\n" + "".join(f"{p.isoformat()},{format(v, 'f')}\n" for p, v in observaciones)).encode("utf-8")


def _escribir(ruta: Path, contenido: bytes) -> None:
    descriptor, temporal = tempfile.mkstemp(dir=ruta.parent, suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as archivo:
            archivo.write(contenido)
            archivo.flush()
            os.fsync(archivo.fileno())
        os.chmod(temporal, 0o644)
        os.replace(temporal, ruta)
    except BaseException:
        Path(temporal).unlink(missing_ok=True)
        raise


# --- Comprobar ---------------------------------------------------------------------------------------

def _leer_csv(contenido: bytes, nombre: str) -> list[tuple[date, Decimal]]:
    filas = list(csv.reader(io.StringIO(contenido.decode("utf-8"))))
    if not filas or ",".join(filas[0]) != ENCABEZADO:
        raise ErrorExportacion(f"{nombre}: el encabezado tiene que ser «{ENCABEZADO}»")
    observaciones = []
    for numero, fila in enumerate(filas[1:], 2):
        try:
            observaciones.append((date.fromisoformat(fila[0]), Decimal(fila[1])))
        except (IndexError, ValueError, InvalidOperation):
            raise ErrorExportacion(f"{nombre}, línea {numero}: no es una fecha y un valor") from None
    return observaciones


def comprobar_release(carpeta: Path) -> tuple[dict | None, list[str]]:
    """El manifiesto de un release exportado y lo que no coincide con él (vacío si está todo bien)."""
    nombre = carpeta.name
    try:
        manifiesto = json.loads((carpeta / "manifiesto.json").read_bytes())
    except (OSError, ValueError):
        return None, [f"{nombre}: falta manifiesto.json o no se puede leer"]
    errores = []
    if manifiesto.get("schema_version") != VERSION or manifiesto.get("release_id") != nombre:
        errores.append(f"{nombre}: el manifiesto no es de este release o de esta versión del formato")
    esperados, filas = {"manifiesto.json"}, []
    for serie in manifiesto.get("series", []):
        archivo = serie.get("csv", "")
        if not CSV.match(archivo):  # que el manifiesto no pueda hacer leer nada fuera de la carpeta
            errores.append(f"{nombre}: el manifiesto nombra un archivo que no es un CSV de serie: {archivo!r}")
            continue
        esperados.add(archivo)
        try:
            contenido = (carpeta / archivo).read_bytes()
        except OSError:
            errores.append(f"{nombre}: falta {archivo}")
            continue
        if _sha256(contenido) != serie.get("sha256"):
            errores.append(f"{nombre}: {archivo} no coincide con el SHA-256 del manifiesto")
            continue
        try:
            observaciones = _leer_csv(contenido, f"{nombre}/{archivo}")
        except ErrorExportacion as error:
            errores.append(str(error))
            continue
        if len(observaciones) != serie.get("count") or (observaciones and (observaciones[0][0].isoformat(), observaciones[-1][0].isoformat())
                                                          != (serie.get("start"), serie.get("end"))):
            errores.append(f"{nombre}: {archivo} no tiene la cantidad o las fechas que dice el manifiesto")
        filas += [(serie["id"], p, v) for p, v in observaciones]
    sobran = sorted(p.name for p in carpeta.iterdir() if p.name not in esperados)
    if sobran:
        errores.append(f"{nombre}: hay archivos que el manifiesto no nombra: {', '.join(sobran)}")
    if not errores and hash_contenido(filas) != manifiesto.get("content_sha256"):
        errores.append(f"{nombre}: el contenido de los CSV no da el hash que se aprobó")
    return manifiesto, errores


def _catalogo(destino: Path) -> tuple[bytes, list[str]]:
    """El catálogo que corresponde a los releases que hay en la copia, solo con los completos y verificados."""
    releases, fuentes, errores = [], {}, []
    for carpeta in sorted((destino / "releases").iterdir()) if (destino / "releases").is_dir() else []:
        if not carpeta.is_dir() or not NOMBRE.match(carpeta.name):
            continue
        manifiesto, problemas = comprobar_release(carpeta)
        if problemas:
            errores += problemas
            continue
        releases.append({"release_id": manifiesto["release_id"], "release_number": manifiesto["release_number"], "source_id": manifiesto["source_id"],
                         "released_at": manifiesto["released_at"], "manifest": f"releases/{carpeta.name}/manifiesto.json",
                         "sha256": _sha256((carpeta / "manifiesto.json").read_bytes()), "series": len(manifiesto["series"])})
        actual = fuentes.get(manifiesto["source_id"])
        if actual is None or manifiesto["release_number"] > actual["_numero"]:
            fuentes[manifiesto["source_id"]] = {"name": manifiesto["source"], "url": manifiesto["source_url"], "license": manifiesto["license"],
                                                "license_url": manifiesto["license_url"], "attribution": manifiesto["attribution"],
                                                "current": manifiesto["release_id"], "_numero": manifiesto["release_number"]}
    releases.sort(key=lambda r: r["release_number"])
    for fuente in fuentes.values():
        del fuente["_numero"]
    catalogo = {"schema_version": VERSION, "sources": dict(sorted(fuentes.items())), "releases": releases}
    return _json(catalogo), errores


def comprobar(destino: Path) -> list[str]:
    """Todo lo que no coincide en una copia: releases contra sus manifiestos y el catálogo contra los releases."""
    esperado, errores = _catalogo(destino)
    try:
        if (destino / "catalogo.json").read_bytes() != esperado:
            errores.append("catalogo.json no corresponde a los releases que hay en la copia")
    except OSError:
        errores.append("falta catalogo.json")
    return errores


# --- Exportar ----------------------------------------------------------------------------------------

def _filas(conn: psycopg.Connection, consulta: str, parametros: tuple = ()) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cursor:
        return cursor.execute(consulta, parametros).fetchall()


def _manifiesto(release: dict, fuente: dict, series: dict[str, dict], por_serie: dict[str, list[tuple[date, Decimal]]]) -> tuple[dict, dict[str, bytes]]:
    procedencia = release["procedencia"] or {}
    entradas = [{k: a.get(k) for k in ("file", "url", "sha256", "retrieved_at", "http_last_modified", "published_at")} for a in procedencia.get("archivos", [])]
    por_clave = {a.get("clave"): a.get("file") for a in procedencia.get("archivos", [])}
    archivos, descripcion = {}, []
    for serie_id, observaciones in sorted(por_serie.items()):
        s, detalle = series[serie_id], (procedencia.get("series") or {}).get(serie_id, {})
        contenido = _csv(observaciones)
        archivos[f"{serie_id}.csv"] = contenido
        descripcion.append({
            "id": serie_id, "name": s["nombre"], "topic": s["tema"], "level": s["nivel"], "territory": s["territorio"],
            "classification": s["clasificacion"], "frequency": s["frecuencia"], "unit": s["unidad"], "basis": s["base"],
            "file": por_clave.get(detalle.get("archivo")), "sheet": detalle.get("hoja"), "source_row": detalle.get("fila_origen"),
            "normalization_notes": detalle.get("notas", []),
            "start": observaciones[0][0].isoformat(), "end": observaciones[-1][0].isoformat(), "count": len(observaciones),
            "csv": f"{serie_id}.csv", "sha256": _sha256(contenido)})
    manifiesto = {
        "schema_version": VERSION, "release_id": release["release_id"], "release_number": release["numero"], "released_at": _iso(release["publicado_en"]),
        "source_id": fuente["id"], "source": fuente["nombre"], "source_url": fuente["url_base"],
        "license": fuente["licencia"], "license_url": fuente["licencia_url"], "attribution": fuente["atribucion"],
        "content_sha256": release["hash_contenido"], "inputs": entradas, "series": descripcion}
    return manifiesto, archivos


def _escribir_release(carpeta: Path, manifiesto: dict, archivos: dict[str, bytes]) -> None:
    """Todo en una carpeta temporal que recién al final toma su nombre: o está completo o no está."""
    temporal = Path(tempfile.mkdtemp(dir=carpeta.parent, prefix=f".{carpeta.name}.", suffix=".tmp"))
    try:
        for nombre, contenido in archivos.items():
            _escribir(temporal / nombre, contenido)
        _escribir(temporal / "manifiesto.json", _json(manifiesto))
        os.chmod(temporal, 0o755)
        os.rename(temporal, carpeta)
    except BaseException:
        shutil.rmtree(temporal, ignore_errors=True)
        raise


def exportar(conn: psycopg.Connection, destino: Path) -> dict:
    """Exporta los releases publicados que falten y rehace el catálogo. Devuelve qué hizo y qué quedó pendiente (con el motivo)."""
    carpeta = destino / "releases"
    carpeta.mkdir(parents=True, exist_ok=True)
    for resto in carpeta.glob(".*.tmp"):  # una corrida que se cortó
        shutil.rmtree(resto, ignore_errors=True)
    fuentes = {f["id"]: f for f in _filas(conn, "SELECT id, nombre, url_base, licencia, licencia_url, atribucion FROM fuente")}
    series = {s["id"]: s for s in _filas(conn, "SELECT id, nombre, tema, nivel, territorio, clasificacion, frecuencia, unidad, base FROM serie")}
    resultado: dict = {"exportados": [], "ya_estaban": 0, "pendientes": []}

    def pendiente(release_id: str, motivo: str) -> None:
        resultado["pendientes"].append({"release_id": release_id, "motivo": motivo})

    for release in _filas(conn, "SELECT * FROM releases_publicados()"):
        release_id = release["release_id"]
        if not NOMBRE.match(release_id):
            pendiente(release_id, "El nombre del release no sirve como nombre de carpeta")
            continue
        if (carpeta / release_id).exists():
            _, problemas = comprobar_release(carpeta / release_id)
            if problemas:  # un release exportado no se reescribe: si no coincide, que lo mire una persona
                pendiente(release_id, "La copia exportada no coincide con su manifiesto: " + "; ".join(problemas[:3]))
            else:
                resultado["ya_estaban"] += 1
            continue
        fuente = fuentes[release["fuente_id"]]
        if not (fuente["licencia"] and fuente["atribucion"]):
            pendiente(release_id, f"La fuente {fuente['id']} no tiene licencia y atribución revisadas: no se redistribuye")
            continue
        filas = [(f["serie_id"], f["periodo"], f["valor"]) for f in _filas(conn, "SELECT * FROM observaciones_de_release(%s)", (release["numero"],))]
        if not filas:
            pendiente(release_id, "El release no tiene observaciones")
            continue
        if hash_contenido(filas) != release["hash_contenido"]:
            pendiente(release_id, "Lo que se reconstruye del release no da el hash que se aprobó: no se exporta")
            continue
        por_serie: dict[str, list[tuple[date, Decimal]]] = {}
        for serie_id, periodo, valor in filas:
            por_serie.setdefault(serie_id, []).append((periodo, valor))
        manifiesto, archivos = _manifiesto(release, fuente, series, por_serie)
        _escribir_release(carpeta / release_id, manifiesto, archivos)
        resultado["exportados"].append(release_id)

    catalogo, problemas = _catalogo(destino)
    if not (destino / "catalogo.json").is_file() or (destino / "catalogo.json").read_bytes() != catalogo:
        _escribir(destino / "catalogo.json", catalogo)
    resultado["vigentes"] = {fid: f["current"] for fid, f in json.loads(catalogo)["sources"].items()}
    resultado["errores"] = problemas
    return resultado


# --- Subir -------------------------------------------------------------------------------------------

def _git(repo: Path, *argumentos: str, chequear: bool = True) -> subprocess.CompletedProcess:
    proceso = subprocess.run(["git", *argumentos], cwd=repo, capture_output=True, text=True, timeout=120)
    if chequear and proceso.returncode != 0:
        raise ErrorExportacion(f"git {argumentos[0]} falló: {(proceso.stderr or proceso.stdout).strip()[:300]}")
    return proceso


def _releases_del_catalogo(contenido: str) -> list[str]:
    try:
        return [r["release_id"] for r in json.loads(contenido).get("releases", [])]
    except (ValueError, AttributeError, KeyError, TypeError):
        return []


def subir(repo: Path, carpeta: str) -> dict:
    """Hace commit de la copia (solo de `carpeta`, relativa al repositorio) y la sube a la rama en la que está. No hace nada si no
    cambió; se niega si hay cambios fuera de la carpeta o si la copia no pasa `comprobar`. Si la rama avanzó mientras tanto, rebasea
    y vuelve a intentar. Devuelve {commit (o None), releases nuevos}."""
    carpeta = carpeta.strip("/")
    prefijo = carpeta + "/"
    cambiados = [r for r in (_git(repo, "diff", "--name-only", "HEAD").stdout + _git(repo, "ls-files", "--others", "--exclude-standard").stdout).splitlines() if r]
    ajenos = sorted({r for r in cambiados if not r.startswith(prefijo)})
    if ajenos:
        raise ErrorExportacion(f"Hay cambios fuera de {carpeta}, que no se mezclan con la copia: {', '.join(ajenos[:5])}")
    if not cambiados:
        return {"commit": None, "releases": []}
    errores = comprobar(repo / carpeta)
    if errores:
        raise ErrorExportacion("La copia no pasa la comprobación, no se sube: " + "; ".join(errores[:3]))
    antes = _git(repo, "show", f"HEAD:{carpeta}/catalogo.json", chequear=False)
    previos = set(_releases_del_catalogo(antes.stdout)) if antes.returncode == 0 else set()
    nuevos = [r for r in _releases_del_catalogo((repo / carpeta / "catalogo.json").read_text(encoding="utf-8")) if r not in previos]
    _git(repo, "add", "-A", "--", carpeta)
    _git(repo, "commit", "-m", ("datos: copia pública de " + ", ".join(nuevos)) if nuevos else "datos: copia pública actualizada")
    if _git(repo, "push", chequear=False).returncode != 0:  # la rama avanzó: lo de la copia no choca con nada, se rebasea
        _git(repo, "pull", "--rebase")
        _git(repo, "push")
    return {"commit": _git(repo, "rev-parse", "HEAD").stdout.strip(), "releases": nuevos}

