#!/usr/bin/env python3
"""Vendor the minimal, reproducible Pyodide runtime used by ChartBay Pro.

The deployed Python image has no Node build step and must not download runtime
dependencies. This script is a maintainer tool: it downloads the pinned core
archive plus the transitive package closure for statsmodels, verifies every
upstream SHA-256, writes a filtered lock file, and records the final files in a
manifest. CI uses ``--check`` without network access.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
VERSION = "0.26.4"
DESTINATION = ROOT / "web" / "static" / "vendor" / "pyodide" / VERSION
CDN_BASE = f"https://cdn.jsdelivr.net/pyodide/v{VERSION}/full"
CORE_URL = (
    f"https://github.com/pyodide/pyodide/releases/download/{VERSION}/"
    f"pyodide-core-{VERSION}.tar.bz2"
)
LOCK_URL = f"{CDN_BASE}/pyodide-lock.json"
LICENSE_URL = f"https://raw.githubusercontent.com/pyodide/pyodide/{VERSION}/LICENSE"
SOURCE_URL = f"https://github.com/pyodide/pyodide/tree/{VERSION}"
OPENBLAS_LICENSE_URL = "https://raw.githubusercontent.com/OpenMathLib/OpenBLAS/v0.3.26/LICENSE"

CORE_SHA256 = "70dba93432f3653155998cc9001f9c200182343c2f95165a2f9e9e4673fa35e8"
LOCK_SHA256 = "cd50b49de944c579045e122fe8628b31f9ce446379f032f36c05e273d38766e0"
LICENSE_SHA256 = "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5"
OPENBLAS_LICENSE_SHA256 = "190b5a9c8d9723fe958ad33916bd7346d96fab3c5ea90832bb02d854f620fcff"
ROOT_PACKAGES = ("statsmodels",)
CORE_FILES = (
    "pyodide.js",
    "pyodide.asm.js",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
)
MANIFEST_NAME = "chartbay-pyodide-manifest.json"


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def download(url: str, expected_sha256: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as response:
        payload = response.read()
    actual = sha256(payload)
    if actual != expected_sha256:
        raise RuntimeError(f"SHA-256 inválido para {url}: {actual} != {expected_sha256}")
    return payload


def package_closure(lock: dict) -> list[str]:
    packages = lock["packages"]
    pending = list(ROOT_PACKAGES)
    selected: set[str] = set()
    while pending:
        name = pending.pop()
        if name in selected:
            continue
        if name not in packages:
            raise RuntimeError(f"El lock oficial no contiene la dependencia {name!r}")
        selected.add(name)
        pending.extend(packages[name].get("depends", []))
    return sorted(selected)


def file_record(path: Path) -> dict[str, int | str]:
    payload = path.read_bytes()
    return {"path": path.name, "bytes": len(payload), "sha256": sha256(payload)}


def vendor() -> None:
    core_archive = download(CORE_URL, CORE_SHA256)
    lock_payload = download(LOCK_URL, LOCK_SHA256)
    license_payload = download(LICENSE_URL, LICENSE_SHA256)
    openblas_license_payload = download(OPENBLAS_LICENSE_URL, OPENBLAS_LICENSE_SHA256)
    official_lock = json.loads(lock_payload)
    selected = package_closure(official_lock)

    with tempfile.TemporaryDirectory(prefix="chartbay-pyodide-") as tmp:
        output = Path(tmp) / VERSION
        output.mkdir(parents=True)

        with tarfile.open(fileobj=io.BytesIO(core_archive), mode="r:bz2") as archive:
            members = {member.name: member for member in archive.getmembers()}
            for filename in CORE_FILES:
                member_name = f"pyodide/{filename}"
                member = members.get(member_name)
                if member is None or not member.isfile():
                    raise RuntimeError(f"El core oficial no contiene {member_name}")
                source = archive.extractfile(member)
                if source is None:
                    raise RuntimeError(f"No se pudo leer {member_name}")
                (output / filename).write_bytes(source.read())

        filtered_lock = {
            "info": official_lock["info"],
            "packages": {name: official_lock["packages"][name] for name in selected},
        }
        (output / "pyodide-lock.json").write_text(
            json.dumps(filtered_lock, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        (output / "LICENSE.PYODIDE").write_bytes(license_payload)
        (output / "LICENSE.OPENBLAS").write_bytes(openblas_license_payload)

        for name in selected:
            package = official_lock["packages"][name]
            filename = package["file_name"]
            payload = download(f"{CDN_BASE}/{filename}", package["sha256"])
            (output / filename).write_bytes(payload)

        files = sorted(
            [
                file_record(path)
                for path in output.iterdir()
                if path.is_file() and path.name != MANIFEST_NAME
            ],
            key=lambda record: str(record["path"]),
        )
        manifest = {
            "pyodide_version": VERSION,
            "root_packages": list(ROOT_PACKAGES),
            "upstream": {
                "core_url": CORE_URL,
                "core_sha256": CORE_SHA256,
                "lock_url": LOCK_URL,
                "lock_sha256": LOCK_SHA256,
                "license_url": LICENSE_URL,
                "license_sha256": LICENSE_SHA256,
                "source_url": SOURCE_URL,
                "openblas_license_url": OPENBLAS_LICENSE_URL,
                "openblas_license_sha256": OPENBLAS_LICENSE_SHA256,
            },
            "packages": selected,
            "files": files,
        }
        (output / MANIFEST_NAME).write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

        DESTINATION.parent.mkdir(parents=True, exist_ok=True)
        if DESTINATION.exists():
            shutil.rmtree(DESTINATION)
        shutil.copytree(output, DESTINATION)

    print(f"Pyodide {VERSION}: {len(selected)} paquetes, {len(files)} archivos vendorizados")


def check() -> None:
    manifest_path = DESTINATION / MANIFEST_NAME
    if not manifest_path.is_file():
        raise RuntimeError(f"Falta {manifest_path.relative_to(ROOT)}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("pyodide_version") != VERSION:
        raise RuntimeError("La versión del manifiesto no coincide con el script")
    if manifest.get("root_packages") != list(ROOT_PACKAGES):
        raise RuntimeError("Los paquetes raíz del manifiesto no coinciden con el script")
    expected_upstream = {
        "core_url": CORE_URL,
        "core_sha256": CORE_SHA256,
        "lock_url": LOCK_URL,
        "lock_sha256": LOCK_SHA256,
        "license_url": LICENSE_URL,
        "license_sha256": LICENSE_SHA256,
        "source_url": SOURCE_URL,
        "openblas_license_url": OPENBLAS_LICENSE_URL,
        "openblas_license_sha256": OPENBLAS_LICENSE_SHA256,
    }
    if manifest.get("upstream") != expected_upstream:
        raise RuntimeError("Los orígenes o hashes del manifiesto no coinciden con el script")
    filtered_lock = json.loads((DESTINATION / "pyodide-lock.json").read_text(encoding="utf-8"))
    selected = package_closure(filtered_lock)
    if manifest.get("packages") != selected or set(filtered_lock["packages"]) != set(selected):
        raise RuntimeError("El cierre de paquetes no coincide entre script, lock y manifiesto")
    expected = {record["path"]: record for record in manifest.get("files", [])}
    actual_names = {
        path.name for path in DESTINATION.iterdir()
        if path.is_file() and path.name != MANIFEST_NAME
    }
    if actual_names != set(expected):
        missing = sorted(set(expected) - actual_names)
        extra = sorted(actual_names - set(expected))
        raise RuntimeError(f"Inventario Pyodide distinto; faltan={missing}, sobran={extra}")
    for name, record in expected.items():
        actual = file_record(DESTINATION / name)
        if actual != record:
            raise RuntimeError(f"Integridad inválida en {name}: {actual} != {record}")
    for package in filtered_lock["packages"].values():
        filename = package["file_name"]
        if expected.get(filename, {}).get("sha256") != package["sha256"]:
            raise RuntimeError(f"El hash de {filename} no coincide con el lock oficial filtrado")
    print(f"Pyodide {VERSION}: integridad OK ({len(expected)} archivos)")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verifica el vendor local sin red")
    args = parser.parse_args()
    check() if args.check else vendor()


if __name__ == "__main__":
    main()
