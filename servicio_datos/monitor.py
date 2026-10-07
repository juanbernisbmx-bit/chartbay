"""El latido: el equipo le avisa a un servicio de afuera, cada pocos minutos, que sigue vivo y cómo está.

Lo que corre en el equipo no puede avisar que el equipo se apagó, que se cortó la red o que cron dejó de correr: el que tendría
que avisar es justamente lo que se cayó. Por eso el control se da vuelta. El equipo late, y un servicio externo (Healthchecks.io,
o uno propio con el mismo protocolo) avisa por su cuenta cuando deja de recibir latidos. Esto también funciona si la interfaz
de revisión solo es accesible por una red privada (Tailscale): no hace falta que nadie de afuera pueda llegar al equipo.

Antes de latir comprueba:

- **revisión local**: que el servicio de revisión responda `/salud` en el equipo.
- **revisión pública**: que la dirección HTTPS responda `/salud` y que el certificado no esté por vencer.
- **base**: que responda.
- **avisos**: que los canales estén configurados y entregando. Si Slack o el correo fallan, este latido es lo único que sale.
- **tareas**: que cron haya corrido cada tarea a tiempo y que no venga fallando (lo lee de lo que deja `tarea.py`).
- **disco**: que haya espacio para el crudo y los respaldos, y que el disco de respaldo esté montado.

Si algo crítico falla, late "con falla" (`/fail`, el protocolo de Healthchecks) y el servicio avisa enseguida, con el detalle
en el cuerpo. Las advertencias van en el cuerpo de un latido normal. Si el equipo no puede latir, el silencio avisa solo.
"""
from __future__ import annotations

import http.client
import json
import shutil
import ssl
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Mapping, Sequence

import psycopg

from servicio_datos.canales import configuracion_desde_entorno as canales_desde_entorno

SALUD_LOCAL = "http://127.0.0.1:8000/salud"  # donde escucha chartbay-revision.service
# Cada cuánto corre cada tarea según el cron, con margen. Si una tarea esperada pasa más que esto sin correr, es una falla.
CADENCIAS: Mapping[str, timedelta] = {
    "ejecutar": timedelta(hours=18),  # 9:30 y 17:30: lo más largo es de 17:30 a 9:30
    "avisar": timedelta(hours=5),  # cada 4 horas
    "agente": timedelta(hours=2),  # cada hora
    "respaldar": timedelta(hours=26),  # una vez por día
}
ESPERADAS = ("ejecutar", "avisar", "respaldar")  # el analista es opcional: si no corre, es una advertencia
FALLAS_SEGUIDAS = 3
CERTIFICADO_FALLA_DIAS, CERTIFICADO_AVISO_DIAS = 7, 21
DISCO_FALLA, DISCO_AVISO = 1 * 2**30, 5 * 2**30
MAX_CUERPO = 10_000  # el detalle entra holgado; un tope evita mandar de más si algo se desborda
TIMEOUT = 10

FALLA, ADVERTENCIA, OK, OMITIDO = "falla", "advertencia", "ok", "omitido"


@dataclass(frozen=True)
class Resultado:
    nombre: str
    estado: str  # falla | advertencia | ok | omitido
    detalle: str


class ErrorLatido(Exception):
    """No se pudo latir. El mensaje no incluye la dirección del monitor, que es una credencial."""


# --- Comprobaciones ---------------------------------------------------------------------------------

class _SinRedirecciones(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None  # una redirección queda como la respuesta que es (3xx), no se sigue


def _breve(error: BaseException) -> str:
    texto = " ".join(str(error).split())
    return f"{type(error).__name__}: {texto[:150]}" if texto else type(error).__name__


def comprobar_salud_local(url: str = SALUD_LOCAL) -> Resultado:
    try:
        with urllib.request.build_opener(_SinRedirecciones()).open(url, timeout=TIMEOUT) as respuesta:
            cuerpo = respuesta.read(100).decode("utf-8", "replace").strip()
            estado = respuesta.status
    except urllib.error.HTTPError as error:
        error.close()
        return Resultado("revisión local", FALLA, f"/salud respondió HTTP {error.code}")
    except (urllib.error.URLError, OSError) as error:
        return Resultado("revisión local", FALLA, f"el servicio de revisión no responde en el equipo ({_breve(getattr(error, 'reason', error))}): systemctl status chartbay-revision")
    if estado != 200 or cuerpo != "ok":
        return Resultado("revisión local", FALLA, f"/salud respondió {estado} «{cuerpo[:40]}» en vez de «ok»")
    return Resultado("revisión local", OK, "responde")


def comprobar_salud_publica(url_base: str | None, ahora: datetime, contexto: ssl.SSLContext | None = None) -> Resultado:
    nombre = "revisión pública"
    if not url_base or not url_base.startswith("https://"):
        return Resultado(nombre, OMITIDO, "sin dirección HTTPS en DATOS_REVISION_URL")
    partes = urllib.parse.urlsplit(url_base)
    conexion = http.client.HTTPSConnection(partes.hostname, partes.port or 443, timeout=TIMEOUT, context=contexto or ssl.create_default_context())
    try:
        conexion.connect()  # el certificado se lee antes de pedir: al terminar la respuesta, http.client cierra el socket
        vence = datetime.fromtimestamp(ssl.cert_time_to_seconds(conexion.sock.getpeercert()["notAfter"]), timezone.utc)
        conexion.request("GET", partes.path.rstrip("/") + "/salud", headers={"User-Agent": "chartbay-latido"})
        respuesta = conexion.getresponse()
        cuerpo = respuesta.read(100).decode("utf-8", "replace").strip()
    except ssl.SSLCertVerificationError as error:
        return Resultado(nombre, FALLA, f"el certificado de {partes.hostname} no es válido ({error.verify_message or 'sin detalle'})")
    except (OSError, http.client.HTTPException, KeyError, ValueError) as error:
        return Resultado(nombre, FALLA, f"{partes.hostname} no responde por HTTPS ({_breve(error)}): ¿Caddy, la red o el túnel?")
    finally:
        conexion.close()
    if respuesta.status != 200 or cuerpo != "ok":
        return Resultado(nombre, FALLA, f"{partes.hostname}/salud respondió {respuesta.status} «{cuerpo[:40]}» en vez de «ok»")
    dias = (vence - ahora).days
    if dias < CERTIFICADO_FALLA_DIAS:
        return Resultado(nombre, FALLA, f"el certificado de {partes.hostname} vence en {dias} días y no se renovó: mirá journalctl -u caddy")
    if dias < CERTIFICADO_AVISO_DIAS:
        return Resultado(nombre, ADVERTENCIA, f"el certificado de {partes.hostname} vence en {dias} días (Caddy suele renovarlo a los 30)")
    return Resultado(nombre, OK, f"responde; el certificado vence en {dias} días")


def comprobar_base(url: str | None) -> list[Resultado]:
    """La base y, si responde, los avisos que salen de ella."""
    if not url:
        return [Resultado("base", FALLA, "falta DATOS_DATABASE_URL")]
    try:
        with psycopg.connect(url, autocommit=True, connect_timeout=TIMEOUT) as conn:
            conn.execute("SELECT 1")
            fallidos, trabados = conn.execute(
                "SELECT count(*) FILTER (WHERE estado = 'fallido' AND creado_en > now() - interval '7 days'), "
                "count(*) FILTER (WHERE estado = 'pendiente' AND intentos >= 2) FROM aviso").fetchone()
    except psycopg.Error as error:
        return [Resultado("base", FALLA, f"no responde ({_breve(error)})")]
    if fallidos or trabados:
        avisos = Resultado("avisos entregados", FALLA, f"{fallidos} avisos se dieron por perdidos en la última semana y {trabados} siguen sin poder entregarse: "
                                                       "revisá Slack o el correo (avisar estado). Mientras tanto, este latido es lo único que sale")
    else:
        avisos = Resultado("avisos entregados", OK, "no hay avisos trabados")
    return [Resultado("base", OK, "responde"), avisos]


def comprobar_canales(env: Mapping[str, str]) -> Resultado:
    try:
        configuracion = canales_desde_entorno(env)
    except ValueError as error:  # el mensaje no trae secretos: ver canales.py
        return Resultado("canales de aviso", FALLA, f"la configuración no sirve: {error}")
    if not configuracion.canales:
        return Resultado("canales de aviso", ADVERTENCIA, "no hay ninguno configurado: nadie se entera de un candidato nuevo ni de una falla")
    return Resultado("canales de aviso", OK, ", ".join(c.nombre for c in configuracion.canales))


def leer_estados(carpeta: Path) -> dict[str, dict | None]:
    """El estado de la última corrida de cada tarea, como lo deja `tarea.py`. None si el archivo está pero no se puede leer."""
    estados: dict[str, dict | None] = {}
    for ruta in carpeta.glob("chartbay-datos-*.estado.json") if carpeta.is_dir() else ():
        nombre = ruta.name[len("chartbay-datos-"):-len(".estado.json")]
        try:
            contenido = json.loads(ruta.read_text(encoding="utf-8"))
            datetime.fromisoformat(contenido["fin"])
            estados[nombre] = contenido if isinstance(contenido.get("codigo"), int) else None
        except (OSError, ValueError, KeyError, TypeError):
            estados[nombre] = None
    return estados


def _horas(intervalo: timedelta) -> str:
    if intervalo.total_seconds() < 60:
        return "menos de 1 min"
    horas = intervalo.total_seconds() / 3600
    return f"{horas:.0f} h" if horas >= 1 else f"{intervalo.total_seconds() / 60:.0f} min"


def comprobar_tareas(carpeta: Path, ahora: datetime, esperadas: Sequence[str] = ESPERADAS) -> list[Resultado]:
    estados, resultados = leer_estados(carpeta), []
    for tarea, cadencia in CADENCIAS.items():
        nombre, critica = f"tarea {tarea}", tarea in esperadas
        if tarea not in estados:
            if critica:
                resultados.append(Resultado(nombre, ADVERTENCIA, "no corrió nunca desde que se instaló: ¿está en /etc/cron.d/chartbay-datos?"))
            continue
        estado = estados[tarea]
        if estado is None:
            resultados.append(Resultado(nombre, ADVERTENCIA, "su archivo de estado no se puede leer"))
            continue
        edad = ahora - datetime.fromisoformat(estado["fin"])
        if edad > cadencia:
            resultados.append(Resultado(nombre, FALLA if critica else ADVERTENCIA,
                                        f"no corre desde hace {_horas(edad)} (corre cada menos de {_horas(cadencia)}): ¿cron, o el equipo estuvo apagado?"))
        elif estado.get("fallas_seguidas", 0) >= FALLAS_SEGUIDAS and critica:
            resultados.append(Resultado(nombre, FALLA, f"falló las últimas {estado['fallas_seguidas']} veces (código {estado['codigo']}): mirá /var/log/chartbay-datos/{tarea}.log"))
        elif estado["codigo"] != 0:
            resultados.append(Resultado(nombre, ADVERTENCIA, f"la última vez terminó con código {estado['codigo']} (mirá {tarea}.log)"))
        else:
            resultados.append(Resultado(nombre, OK, f"corrió bien hace {_horas(edad)}"))
    return resultados


def comprobar_discos(carpetas: Mapping[str, Path | None], disco: Callable[[Path], object] = shutil.disk_usage) -> list[Resultado]:
    resultados = []
    for nombre, carpeta in carpetas.items():
        if carpeta is None:
            continue
        if not carpeta.is_dir():
            resultados.append(Resultado(f"disco del {nombre}", FALLA, f"no existe {carpeta}" + (": ¿está montado el disco?" if nombre == "respaldo" else "")))
            continue
        libre = disco(carpeta).free
        detalle = f"{libre / 2**30:.1f} GB libres"
        estado = FALLA if libre < DISCO_FALLA else ADVERTENCIA if libre < DISCO_AVISO else OK
        resultados.append(Resultado(f"disco del {nombre}", estado, detalle + (": casi lleno" if estado != OK else "")))
    return resultados


@dataclass(frozen=True)
class Configuracion:
    url_monitor: str | None  # DATOS_MONITOR_URL: la dirección de latido (una credencial)
    url_base: str | None  # DATOS_DATABASE_URL
    url_publica: str | None  # DATOS_REVISION_URL
    salud_local: str  # DATOS_MONITOR_SALUD_LOCAL
    carpeta_tareas: Path  # DATOS_RUN_DIR, la misma que usa tarea.py
    crudo: Path | None  # DATOS_CRUDO_DIR
    respaldo: Path | None  # DATOS_RESPALDO_DIR
    entorno: Mapping[str, str]


def configuracion_desde_entorno(env: Mapping[str, str]) -> Configuracion:
    texto = lambda nombre: (env.get(nombre) or "").strip() or None  # noqa: E731
    crudo, respaldo = texto("DATOS_CRUDO_DIR"), texto("DATOS_RESPALDO_DIR")
    return Configuracion(texto("DATOS_MONITOR_URL"), texto("DATOS_DATABASE_URL"), texto("DATOS_REVISION_URL"), texto("DATOS_MONITOR_SALUD_LOCAL") or SALUD_LOCAL,
                         Path(texto("DATOS_RUN_DIR") or tempfile.gettempdir()), Path(crudo) if crudo else None, Path(respaldo) if respaldo else None, env)


def _seguro(nombre: str, comprobacion: Callable[[], Resultado | list[Resultado]]) -> list[Resultado]:
    """Una comprobación que se rompe es una falla más, con su detalle: nunca puede impedir el latido."""
    try:
        resultado = comprobacion()
    except Exception as error:  # noqa: BLE001 — a propósito: lo que sea, el latido tiene que salir
        return [Resultado(nombre, FALLA, f"la comprobación se rompió ({_breve(error)})")]
    return resultado if isinstance(resultado, list) else [resultado]


def comprobar(conf: Configuracion, ahora: datetime, contexto: ssl.SSLContext | None = None) -> list[Resultado]:
    return [
        *_seguro("revisión local", lambda: comprobar_salud_local(conf.salud_local)),
        *_seguro("revisión pública", lambda: comprobar_salud_publica(conf.url_publica, ahora, contexto)),
        *_seguro("base", lambda: comprobar_base(conf.url_base)),
        *_seguro("canales de aviso", lambda: comprobar_canales(conf.entorno)),
        *_seguro("tareas", lambda: comprobar_tareas(conf.carpeta_tareas, ahora)),
        *_seguro("discos", lambda: comprobar_discos({"crudo": conf.crudo, "respaldo": conf.respaldo})),
    ]


def resumen(resultados: Sequence[Resultado]) -> tuple[bool, str]:
    """(sin fallas, texto). Primero lo que falla, después las advertencias, lo que anda y lo que no se comprobó."""
    marcas = {FALLA: "✗", ADVERTENCIA: "!", OK: "✓", OMITIDO: "·"}
    fallas, advertencias = (sum(r.estado == e for r in resultados) for e in (FALLA, ADVERTENCIA))
    if fallas:
        titulo = f"ChartBay datos: {fallas} {'problema' if fallas == 1 else 'problemas'}"
    else:
        titulo = "ChartBay datos: todo bien" + (f", con {advertencias} {'advertencia' if advertencias == 1 else 'advertencias'}" if advertencias else "")
    orden = sorted(resultados, key=lambda r: list(marcas).index(r.estado))
    return not fallas, "\n".join([titulo, *(f"{marcas[r.estado]} {r.nombre}: {r.detalle}" for r in orden)])


# --- El latido --------------------------------------------------------------------------------------

class Monitor:
    """Le late a un servicio con el protocolo de Healthchecks: POST a la dirección, o a `<dirección>/fail` si hay una falla."""

    def __init__(self, url: str, *, esquemas: tuple[str, ...] = ("https",), timeout: float = TIMEOUT, intentos: int = 3, pausa: float = 2.0):
        partes = urllib.parse.urlsplit(url)
        if partes.scheme not in esquemas or not partes.hostname:
            raise ValueError("DATOS_MONITOR_URL tiene que ser una dirección https:// de un servicio de afuera del equipo")
        self._url, self._timeout, self._intentos, self._pausa = url.rstrip("/"), timeout, intentos, pausa
        self._abridor = urllib.request.build_opener(_SinRedirecciones())

    def latir(self, cuerpo: str, falla: bool = False) -> None:
        datos = cuerpo.encode("utf-8")[:MAX_CUERPO]
        destino = self._url + ("/fail" if falla else "")
        ultimo = "sin intentos"
        for intento in range(self._intentos):
            if intento:
                time.sleep(self._pausa * intento)
            pedido = urllib.request.Request(destino, data=datos, method="POST", headers={"Content-Type": "text/plain; charset=utf-8", "User-Agent": "chartbay-latido"})
            try:
                with self._abridor.open(pedido, timeout=self._timeout) as respuesta:
                    if 200 <= respuesta.status < 300:
                        return
                    ultimo = f"el monitor respondió HTTP {respuesta.status}"
            except urllib.error.HTTPError as error:
                error.close()
                ultimo = f"el monitor respondió HTTP {error.code}"
                if error.code < 500:  # un 4xx no se arregla reintentando (dirección mal copiada, chequeo borrado)
                    break
            except (urllib.error.URLError, OSError) as error:
                ultimo = f"no se pudo hablar con el monitor ({type(getattr(error, 'reason', error)).__name__})"
        raise ErrorLatido(ultimo)
