"""
Cliente HTTP mínimo basado en la librería estándar (urllib).

Se usa stdlib a propósito: el módulo de proveedores no agrega ninguna
dependencia nueva al proyecto y queda autocontenido.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .base import ProviderHTTPError

_UA = "ChartBay/1.0 (+frequent-data)"


def get_json(url: str, params: dict | None = None, timeout: int = 20) -> Any:
    """GET a `url` con querystring opcional; devuelve el JSON parseado."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        raise ProviderHTTPError(f"HTTP {e.code} consultando la fuente de datos") from e
    except urllib.error.URLError as e:
        raise ProviderHTTPError(f"No se pudo conectar con la fuente: {e.reason}") from e
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise ProviderHTTPError("La fuente devolvió una respuesta no válida") from e
