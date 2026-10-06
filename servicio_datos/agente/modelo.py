"""Cliente del modelo local: un servidor de chat compatible con la API de OpenAI (Ollama, llama.cpp, LM Studio, vLLM)
que corre en ESTA computadora.

- **Solo escucha en la propia máquina.** Se rechaza cualquier dirección que no sea localhost: así los datos no salen
  de la computadora y la dirección configurada no puede apuntar a otro lado (ni a un servicio interno de la red).
  Si el modelo corre en otro equipo, se llega con un túnel a localhost, no abriendo esta restricción.
- **No usa claves.** Un servidor local no las necesita, y no hay nada que filtrar.
- **No confía en lo que devuelve.** Los modelos chicos agregan texto alrededor del JSON, lo envuelven en bloques de código
  o piensan en voz alta antes (`<think>`). Acá se extrae el primer objeto JSON, y lo que salga de ahí lo valida
  `dictamen.validar_dictamen`; este módulo solo garantiza que, o devuelve algo que se parsea, o falla con un error claro.
- Los errores no incluyen la dirección ni el cuerpo de la respuesta.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Mapping, Sequence

LOCALES = ("localhost", "127.0.0.1", "::1")
URL_POR_DEFECTO = "http://127.0.0.1:11434/v1"  # Ollama


class ErrorModelo(Exception):
    """No se pudo obtener un análisis del modelo. El mensaje no incluye la dirección ni la respuesta."""


class _SinRedirecciones(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ErrorModelo("El servidor del modelo respondió con una redirección, que no se sigue")


def extraer_json(texto: str) -> object:
    """El primer objeto JSON del texto, ignorando bloques de pensamiento, vallas de código y prosa alrededor."""
    texto = re.sub(r"<think>.*?</think>", "", texto, flags=re.DOTALL | re.IGNORECASE)
    texto = re.split(r"<think>", texto, maxsplit=1, flags=re.IGNORECASE)[0]  # un pensamiento que no se cerró (se cortó) es un borrador, no la respuesta
    texto = re.sub(r"```(?:json)?", "", texto, flags=re.IGNORECASE)
    decodificador = json.JSONDecoder()
    for inicio in (m.start() for m in re.finditer(r"\{", texto)):
        try:
            objeto, _ = decodificador.raw_decode(texto, inicio)
        except ValueError:
            continue
        if isinstance(objeto, dict):
            return objeto
    raise ErrorModelo("La respuesta del modelo no contiene un objeto JSON")


class ModeloLocal:
    def __init__(self, modelo: str, url: str = URL_POR_DEFECTO, timeout: float = 180, max_tokens: int = 700):
        partes = urllib.parse.urlsplit(url)
        if partes.scheme not in ("http", "https") or partes.hostname not in LOCALES:
            raise ValueError("El modelo tiene que correr en esta computadora: la dirección tiene que ser localhost, 127.0.0.1 o ::1")
        if not modelo.strip():
            raise ValueError("Falta el nombre del modelo")
        self.modelo, self.nombre = modelo.strip(), modelo.strip()
        self._url = url.rstrip("/") + "/chat/completions"
        self._timeout, self._max_tokens = timeout, max_tokens
        self._abridor = urllib.request.build_opener(_SinRedirecciones())

    def _pedir(self, mensajes: Sequence[Mapping[str, str]], formato_json: bool) -> str:
        cuerpo = {"model": self.modelo, "messages": list(mensajes), "temperature": 0, "stream": False, "max_tokens": self._max_tokens}
        if formato_json:
            cuerpo["response_format"] = {"type": "json_object"}
        pedido = urllib.request.Request(self._url, data=json.dumps(cuerpo).encode("utf-8"), headers={"Content-Type": "application/json"}, method="POST")
        with self._abridor.open(pedido, timeout=self._timeout) as respuesta:
            return respuesta.read().decode("utf-8", errors="replace")

    def consultar_json(self, mensajes: Sequence[Mapping[str, str]]) -> object:
        """Pregunta al modelo y devuelve el objeto JSON que respondió, o falla con ErrorModelo."""
        try:
            try:
                crudo = self._pedir(mensajes, formato_json=True)
            except urllib.error.HTTPError as error:
                if error.code != 400:
                    raise
                crudo = self._pedir(mensajes, formato_json=False)  # no todos los servidores aceptan response_format
            contenido = json.loads(crudo)["choices"][0]["message"]["content"]
        except ErrorModelo:
            raise
        except urllib.error.HTTPError as error:
            raise ErrorModelo(f"El servidor del modelo respondió HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            motivo = error.reason if isinstance(error, urllib.error.URLError) else error
            raise ErrorModelo(f"No se pudo hablar con el servidor del modelo ({type(motivo).__name__})") from None
        except (ValueError, KeyError, IndexError, TypeError):
            raise ErrorModelo("El servidor del modelo respondió con un formato que no se entiende") from None
        if not isinstance(contenido, str) or not contenido.strip():
            raise ErrorModelo("El modelo respondió vacío")
        return extraer_json(contenido)

    def probar(self) -> float:
        """Una consulta mínima para comprobar que el servidor y el modelo responden JSON. Devuelve los segundos que tardó."""
        inicio = time.monotonic()
        resultado = self.consultar_json([
            {"role": "system", "content": 'Respondé solo con un objeto JSON.'},
            {"role": "user", "content": 'Devolvé exactamente {"ok": true}'}])
        if not isinstance(resultado, dict):
            raise ErrorModelo("La respuesta de prueba no es un objeto JSON")
        return time.monotonic() - inicio


def modelo_desde_entorno(env: Mapping[str, str]) -> ModeloLocal | None:
    """El modelo configurado, o None si no hay (sin DATOS_AGENTE_MODELO el análisis con modelo queda apagado)."""
    nombre = (env.get("DATOS_AGENTE_MODELO") or "").strip()
    if not nombre:
        return None
    texto = (env.get("DATOS_AGENTE_TIMEOUT") or "180").strip()
    if not texto.isdigit() or not 5 <= int(texto) <= 3600:
        raise ValueError("DATOS_AGENTE_TIMEOUT tiene que ser un número de segundos entre 5 y 3600")
    return ModeloLocal(nombre, (env.get("DATOS_AGENTE_URL") or URL_POR_DEFECTO).strip(), float(texto))
