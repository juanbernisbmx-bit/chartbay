"""Cliente HTTP del colector: solo hosts permitidos, con reintentos y tope de tamaño."""
from __future__ import annotations

import http.client
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from email.utils import parsedate_to_datetime
from typing import Callable

from servicio_datos.ipc.fuente import HOST

USER_AGENT = "ChartBay-datos/0.1 (colector de series oficiales)"
MAX_BYTES = 40 * 1024 * 1024


class ErrorHttp(Exception):
    """No se pudo obtener la respuesta: red caída, servidor roto o pedido rechazado."""


@dataclass(frozen=True)
class Respuesta:
    estado: int
    contenido: bytes
    tipo: str
    last_modified: datetime | None


class _SoloMismoHost(urllib.request.HTTPRedirectHandler):
    def __init__(self, validar: Callable[[str], None]):
        self._validar = validar

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            self._validar(newurl)
        except ErrorHttp as error:
            raise ErrorHttp(f"Redirección rechazada: {error}") from error
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class ClienteHttp:
    def __init__(
        self,
        hosts: tuple[str, ...] = (HOST,),
        esquemas: tuple[str, ...] = ("https",),
        timeout: float = 30,
        reintentos: int = 3,
        espera: float = 1.0,
        max_bytes: int = MAX_BYTES,
        dormir: Callable[[float], None] = time.sleep,
    ):
        self.hosts, self.esquemas = hosts, esquemas
        self.timeout, self.reintentos, self.espera = timeout, reintentos, espera
        self.max_bytes, self.dormir = max_bytes, dormir
        self._opener = urllib.request.build_opener(_SoloMismoHost(self._validar))

    def _validar(self, url: str) -> None:
        partes = urllib.parse.urlsplit(url)
        if partes.scheme not in self.esquemas or partes.hostname not in self.hosts:
            raise ErrorHttp(f"URL no permitida: {url}")

    def get(self, url: str) -> Respuesta:
        """GET con reintentos. 404 vuelve como Respuesta; el resto de los fallos, como ErrorHttp."""
        self._validar(url)
        ultimo = ""
        for intento in range(self.reintentos):
            if intento:
                self.dormir(self.espera * 2 ** (intento - 1))
            pedido = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "identity"})
            try:
                with self._opener.open(pedido, timeout=self.timeout) as respuesta:
                    contenido = respuesta.read(self.max_bytes + 1)
                    if len(contenido) > self.max_bytes:
                        raise ErrorHttp(f"La respuesta de {url} supera {self.max_bytes} bytes")
                    return Respuesta(
                        respuesta.status,
                        contenido,
                        respuesta.headers.get("Content-Type", ""),
                        _fecha(respuesta.headers.get("Last-Modified")),
                    )
            except urllib.error.HTTPError as error:
                error.close()
                if error.code == 404:
                    return Respuesta(404, b"", "", None)
                if error.code < 500:
                    raise ErrorHttp(f"{url} respondió HTTP {error.code}") from error
                ultimo = f"HTTP {error.code}"
            except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as error:
                ultimo = f"{type(error).__name__}: {error}"
        raise ErrorHttp(f"No se pudo bajar {url} tras {self.reintentos} intentos ({ultimo})")


def _fecha(valor: str | None) -> datetime | None:
    if not valor:
        return None
    try:
        return parsedate_to_datetime(valor)
    except (TypeError, ValueError):
        return None
