"""Límite de solicitudes por IP, en la memoria del proceso.

Render corre la app con un solo worker de gunicorn (ver render.yaml), así que un
contador en memoria ve todas las requests. Con más de un worker cada proceso
contaría por separado y el límite efectivo se multiplicaría: ahí haría falta un
almacén compartido, como Redis.

Esto frena a una IP que martilla el sitio —un script en loop, un scraper, un
escaneo de rutas—, no a un ataque distribuido: ese se corta antes de llegar a
Flask, en Cloudflare, que Render ya tiene delante.
"""
from __future__ import annotations

import ipaddress
import math
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Callable, Mapping, Optional, Sequence


@dataclass(frozen=True)
class Regla:
    nombre: str
    limite: int      # solicitudes permitidas...
    ventana_s: int   # ...cada tantos segundos
    # Rutas exactas, o prefijos si terminan en "/". Vacío: la regla general.
    rutas: tuple[str, ...] = ()

    def cubre(self, ruta: str) -> bool:
        return any(ruta == r or (r.endswith("/") and ruta.startswith(r)) for r in self.rutas)


class Limitador:
    """Ventana deslizante aproximada por (regla, IP).

    Guarda dos contadores por clave —el de la ventana fija actual y el de la
    anterior— y estima la tasa pesando la anterior por la fracción que falta de
    la actual. Ocupa lo mismo por IP sin importar cuántas requests haga, y no
    tiene el borde de las ventanas fijas, donde entraban dos límites enteros en
    un segundo: el final de una ventana y el principio de la siguiente.
    """

    def __init__(self, reglas: Sequence[Regla], *, max_claves: int = 50_000,
                 reloj: Callable[[], float] = time.monotonic) -> None:
        generales = [r for r in reglas if not r.rutas]
        if len(generales) != 1:
            raise ValueError("hace falta exactamente una regla general (sin rutas)")
        self._general = generales[0]
        self._especificas = [r for r in reglas if r.rutas]
        self._max_claves = max_claves
        self._reloj = reloj
        self._lock = threading.Lock()
        # (regla, ip) -> [índice de ventana, cuenta actual, cuenta anterior]
        self._cuentas: OrderedDict[tuple[str, str], list[int]] = OrderedDict()

    def regla_para(self, ruta: str) -> Regla:
        for regla in self._especificas:
            if regla.cubre(ruta):
                return regla
        return self._general

    def registrar(self, ruta: str, ip: str) -> Optional[int]:
        """Cuenta la solicitud: None si pasa, o cuántos segundos esperar si no."""
        regla = self.regla_para(ruta)
        ahora = self._reloj()
        ventana = int(ahora // regla.ventana_s)
        transcurrido = (ahora % regla.ventana_s) / regla.ventana_s
        clave = (regla.nombre, ip)
        with self._lock:
            cuenta = self._cuentas.get(clave)
            if cuenta is None or cuenta[0] < ventana - 1:
                cuenta = [ventana, 0, 0]
            elif cuenta[0] == ventana - 1:
                cuenta = [ventana, 0, cuenta[1]]
            estimado = cuenta[1] + cuenta[2] * (1 - transcurrido)
            if estimado >= regla.limite:
                # Lo rechazado no suma: quien sigue insistiendo queda afuera
                # mientras la tasa estimada no baje, pero no se autocastiga más.
                self._guardar(clave, cuenta)
                return max(1, math.ceil(regla.ventana_s * (1 - transcurrido)))
            cuenta[1] += 1
            self._guardar(clave, cuenta)
            return None

    def _guardar(self, clave: tuple[str, str], cuenta: list[int]) -> None:
        self._cuentas[clave] = cuenta
        self._cuentas.move_to_end(clave)
        while len(self._cuentas) > self._max_claves:
            # Sale la menos reciente: un barrido de IPs distintas no puede hacer
            # crecer la memoria del proceso sin techo.
            self._cuentas.popitem(last=False)

    def __len__(self) -> int:
        return len(self._cuentas)


# Detrás de Render el socket lo abre su proxy, así que request.remote_addr es la
# IP del proxy y todos los visitantes compartirían un único contador. Render
# está detrás de Cloudflare, que escribe CF-Connecting-IP con la IP real del
# cliente en cada request y pisa la que venga. X-Forwarded-For, en cambio,
# conserva lo que mande el cliente y Render sólo le agrega entradas, así que
# queda como último recurso.
#
# Fuera de Render esas cabeceras las escribe quien quiera: confiar en ellas
# dejaría esquivar el límite cambiando un header, por eso sólo se leen con
# `detras_de_render`.
_CABECERAS_DE_CLOUDFLARE = ("CF-Connecting-IP", "True-Client-IP")


def ip_del_cliente(cabeceras: Mapping[str, str], remote_addr: Optional[str], *,
                   detras_de_render: bool) -> str:
    candidatas = []
    if detras_de_render:
        candidatas += [cabeceras.get(nombre, "") for nombre in _CABECERAS_DE_CLOUDFLARE]
        candidatas.append(cabeceras.get("X-Forwarded-For", "").split(",")[0])
    candidatas.append(remote_addr or "")
    for candidata in candidatas:
        try:
            ip = ipaddress.ip_address(candidata.strip())
        except ValueError:
            continue
        if ip.version == 6:
            # Un cliente IPv6 suele tener un /64 entero para él: contar por
            # prefijo evita que rote de dirección para esquivar el límite.
            return str(ipaddress.ip_network(f"{ip}/64", strict=False))
        return str(ip)
    return "desconocida"
