"""Almacén del crudo: archivos tal cual los bajó el colector, inmutables.

El nombre sale del contenido (`ab/ab12…ef.xls`), así que guardar dos veces lo
mismo no duplica nada y un archivo no puede cambiar sin que cambie su nombre.
"""
from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path

EXTENSION = re.compile(r"^\.[a-z0-9]{1,5}$")


class ErrorCrudo(Exception):
    pass


class AlmacenCrudo:
    def __init__(self, directorio: Path):
        self.directorio = Path(directorio).resolve()
        self.directorio.mkdir(parents=True, exist_ok=True)

    def guardar(self, contenido: bytes, extension: str = ".xls") -> tuple[str, str]:
        """Guarda el contenido y devuelve (sha256, ruta relativa). Idempotente."""
        if not EXTENSION.match(extension):
            raise ErrorCrudo(f"Extensión inválida: {extension!r}")
        sha256 = hashlib.sha256(contenido).hexdigest()
        relativa = f"{sha256[:2]}/{sha256}{extension}"
        destino = self.directorio / relativa
        if destino.exists():
            if hashlib.sha256(destino.read_bytes()).hexdigest() != sha256:
                raise ErrorCrudo(f"El crudo {relativa} existe pero su contenido no coincide: está dañado")
            return sha256, relativa
        destino.parent.mkdir(parents=True, exist_ok=True)
        # Se escribe aparte y se renombra: nadie ve nunca un archivo a medias.
        descriptor, temporal = tempfile.mkstemp(dir=destino.parent, suffix=".tmp")
        try:
            with os.fdopen(descriptor, "wb") as archivo:
                archivo.write(contenido)
                archivo.flush()
                os.fsync(archivo.fileno())
            os.chmod(temporal, 0o444)
            os.replace(temporal, destino)
        except BaseException:
            Path(temporal).unlink(missing_ok=True)
            raise
        return sha256, relativa

    def ruta(self, relativa: str) -> Path:
        """Ruta absoluta de un crudo ya guardado; no sale nunca de la carpeta."""
        destino = (self.directorio / relativa).resolve()
        if self.directorio not in destino.parents:
            raise ErrorCrudo(f"Ruta fuera del almacén: {relativa!r}")
        if not destino.is_file():
            raise ErrorCrudo(f"No existe el crudo {relativa}")
        return destino
