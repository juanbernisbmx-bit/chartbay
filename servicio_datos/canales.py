"""Canales de aviso: Slack (webhook) y correo (SMTP), y cómo se configuran desde el entorno.

Dos reglas guían todo el módulo:

- Los secretos (la URL del webhook de Slack, la clave del correo) no salen nunca en un error,
  un log ni un mensaje: una falla de entrega se describe con su tipo y su código, nada más.
- Lo que va en un aviso viene de la base (errores de descarga, nombres de fuente) y no es de
  confianza. En Slack se escapa para que no pueda armar enlaces ni menciones (`<!channel>`);
  en el correo se limpia el asunto para que no pueda inyectar cabeceras.
"""
from __future__ import annotations

import json
import re
import smtplib
import ssl
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from email.message import EmailMessage
from typing import Mapping, Protocol

LOCALES = ("localhost", "127.0.0.1", "::1")
DIRECCION = re.compile(r"^[^\s@<>,;\"']+@[^\s@<>,;\"']+\.[^\s@<>,;\"']+$|^[^\s@<>,;\"']+@localhost$")


class ErrorEnvio(Exception):
    """No se pudo entregar. El mensaje no contiene secretos."""


@dataclass(frozen=True)
class Mensaje:
    asunto: str
    cuerpo: str
    enlace: str | None = None


class Canal(Protocol):
    nombre: str

    def enviar(self, mensaje: Mensaje) -> None: ...


def _una_linea(texto: str) -> str:
    return re.sub(r"\s+", " ", texto).strip()


def escapar_slack(texto: str) -> str:
    """Slack interpreta &, < y >: sin escaparlos, un texto podría armar un enlace o un @channel."""
    return texto.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class _SinRedirecciones(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ErrorEnvio("Slack respondió con una redirección, que no se sigue")


class CanalSlack:
    nombre = "slack"

    def __init__(self, url: str, *, hosts: tuple[str, ...] = ("hooks.slack.com",), esquemas: tuple[str, ...] = ("https",), timeout: float = 10):
        partes = urllib.parse.urlsplit(url)
        if partes.scheme not in esquemas or partes.hostname not in hosts:
            # No se repite la URL: es una credencial.
            raise ValueError("La URL del webhook de Slack tiene que ser https://hooks.slack.com/...")
        self._url, self._timeout = url, timeout
        self._opener = urllib.request.build_opener(_SinRedirecciones())

    def enviar(self, mensaje: Mensaje) -> None:
        texto = f"*{escapar_slack(_una_linea(mensaje.asunto))}*\n{escapar_slack(mensaje.cuerpo)}"
        if mensaje.enlace:
            texto += f"\n<{mensaje.enlace}|Abrir en la interfaz de revisión>"
        pedido = urllib.request.Request(self._url, data=json.dumps({"text": texto[:3500]}).encode("utf-8"),
                                        headers={"Content-Type": "application/json"}, method="POST")
        try:
            with self._opener.open(pedido, timeout=self._timeout) as respuesta:
                if respuesta.status != 200:
                    raise ErrorEnvio(f"Slack respondió HTTP {respuesta.status}")
        except ErrorEnvio:
            raise
        except urllib.error.HTTPError as error:
            raise ErrorEnvio(f"Slack respondió HTTP {error.code}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            # Solo el tipo: el texto del error puede traer la URL.
            raise ErrorEnvio(f"No se pudo conectar con Slack ({type(error.reason if isinstance(error, urllib.error.URLError) else error).__name__})") from None


class CanalEmail:
    nombre = "email"

    def __init__(self, host: str, puerto: int, de: str, para: list[str], usuario: str | None = None, clave: str | None = None,
                 seguridad: str = "starttls", timeout: float = 15):
        if seguridad not in ("starttls", "ssl", "ninguna"):
            raise ValueError("DATOS_AVISOS_SMTP_SEGURIDAD tiene que ser starttls, ssl o ninguna")
        if seguridad == "ninguna" and host not in LOCALES:
            raise ValueError("Sin cifrado solo se admite un servidor local: la clave y el mensaje viajarían a la vista")
        for direccion in [de, *para]:
            if not DIRECCION.match(direccion):
                raise ValueError(f"Dirección de correo inválida: {direccion!r}")
        if not para:
            raise ValueError("Falta al menos un destinatario en DATOS_AVISOS_PARA")
        self._host, self._puerto, self._de, self._para = host, puerto, de, para
        self._usuario, self._clave, self._seguridad, self._timeout = usuario, clave, seguridad, timeout

    def enviar(self, mensaje: Mensaje) -> None:
        correo = EmailMessage()
        correo["Subject"] = _una_linea(mensaje.asunto)[:200]
        correo["From"], correo["To"] = self._de, ", ".join(self._para)
        correo.set_content(mensaje.cuerpo + (f"\n\nAbrir en la interfaz de revisión:\n{mensaje.enlace}\n" if mensaje.enlace else "\n"))
        try:
            if self._seguridad == "ssl":
                servidor = smtplib.SMTP_SSL(self._host, self._puerto, timeout=self._timeout, context=ssl.create_default_context())
            else:
                servidor = smtplib.SMTP(self._host, self._puerto, timeout=self._timeout)
            with servidor:
                if self._seguridad == "starttls":
                    servidor.starttls(context=ssl.create_default_context())
                if self._usuario:
                    servidor.login(self._usuario, self._clave or "")
                servidor.send_message(correo)
        except (smtplib.SMTPException, OSError) as error:
            # Solo el tipo y, si lo hay, el código: el texto del servidor puede traer el usuario.
            codigo = getattr(error, "smtp_code", None)
            raise ErrorEnvio(f"No se pudo enviar el correo ({type(error).__name__}{f', código {codigo}' if codigo else ''})") from None


@dataclass(frozen=True)
class Configuracion:
    canales: tuple[Canal, ...]
    url_base: str | None  # dirección de la interfaz de revisión, para los enlaces
    recordatorio_dias: int = 3  # días hasta el primer recordatorio de un candidato abierto; 0 los desactiva


def configuracion_desde_entorno(env: Mapping[str, str]) -> Configuracion:
    """Los canales que estén configurados; sin ninguno, el sistema no avisa (y no acumula avisos)."""
    canales: list[Canal] = []
    if env.get("DATOS_AVISOS_SLACK_URL"):
        canales.append(CanalSlack(env["DATOS_AVISOS_SLACK_URL"]))
    if env.get("DATOS_AVISOS_SMTP_HOST"):
        para = [d.strip() for d in env.get("DATOS_AVISOS_PARA", "").split(",") if d.strip()]
        canales.append(CanalEmail(
            env["DATOS_AVISOS_SMTP_HOST"], int(env.get("DATOS_AVISOS_SMTP_PUERTO", "587")), env.get("DATOS_AVISOS_DE", ""), para,
            env.get("DATOS_AVISOS_SMTP_USUARIO") or None, env.get("DATOS_AVISOS_SMTP_CLAVE") or None,
            env.get("DATOS_AVISOS_SMTP_SEGURIDAD", "starttls")))
    url = (env.get("DATOS_REVISION_URL") or "").strip().rstrip("/") or None
    if url and not re.match(r"^https?://", url):
        raise ValueError("DATOS_REVISION_URL tiene que empezar con https:// (o http:// en una prueba local)")
    texto = env.get("DATOS_AVISOS_RECORDATORIO_DIAS", "3").strip()
    if not texto.isdigit() or int(texto) > 60:
        raise ValueError("DATOS_AVISOS_RECORDATORIO_DIAS tiene que ser un número de días entre 0 (sin recordatorios) y 60")
    return Configuracion(tuple(canales), url, int(texto))
