"""Avisos: detecta lo que merece que alguien se entere y lo entrega por Slack o correo.

Se avisa de lo que un sistema que se supone silencioso no puede callar:

- `candidato_nuevo`: hay un candidato esperando revisión.
- `candidato_pendiente`: ese candidato sigue abierto días después. Recordatorios escalonados (a los 3
  días, a los 7, a los 14 y desde ahí uno por semana), cada hito una sola vez.
- `corrida_fallida`: una corrida falló y nadie la resolvió. Se avisa una vez por racha, no por
  cada corrida que siga fallando.
- `sin_datos`: pasó la ventana del mes y no llegó el dato (ni lo publicado ni un candidato abierto
  lo cubren).
- `colector_inactivo`: no hay corridas hace días. Sin esto, un cron muerto lo silenciaría todo.
- `respaldo_fallido`: falló el respaldo de la base o del crudo. Una vez por racha.
- `respaldo_atrasado`: no hay un respaldo bueno hace días (falla, o directamente dejó de correr). Solo después del primer
  respaldo: antes no hay nada que extrañar.

La detección mira el estado de la base, no eventos: se puede correr sola, desde cualquier
proceso, y da lo mismo cuántas veces. Cada aviso se registra con una clave única antes de
entregarse (bandeja de salida), así que no se repite y un canal caído no pierde nada: se
reintenta en la corrida siguiente. Antes de entregar se vuelve a comprobar que siga siendo
cierto; si el candidato ya se resolvió, el aviso se descarta en vez de molestar.

Detectar, comprobar y anotar cómo fue cada entrega son funciones de la base (migración 0014), las
mismas que usa la Edge Function `avisar` en Supabase. Acá quedan los canales (Slack y correo).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Sequence

import psycopg
from psycopg.types.json import Jsonb

from servicio_datos.canales import Canal, ErrorEnvio, Mensaje
from servicio_datos.ipc.validacion import DIA_LIMITE_PUBLICACION

MAX_INTENTOS = 5  # el de `registrar_entrega` en la base
RECORDATORIO_DIAS = 3  # primer recordatorio de un candidato abierto; 0 los desactiva
RESERVA_SEGUNDOS = 300  # cuánto queda reservado un aviso tomado para entregar, por si quien lo tomó se cae


@dataclass(frozen=True)
class Resultado:
    creados: int = 0
    enviados: int = 0
    descartados: int = 0
    fallidos: int = 0  # se agotaron los intentos
    pendientes: int = 0  # siguen esperando un reintento
    ocupado: bool = False  # otra entrega tenía avisos reservados
    errores: tuple[str, ...] = ()  # por canal, sin secretos


def detectar(conn: psycopg.Connection, hoy: date, ahora: datetime | None = None, dia_limite: int = DIA_LIMITE_PUBLICACION,
             recordatorio_dias: int = RECORDATORIO_DIAS) -> int:
    """Registra los avisos que falten (`detectar_avisos` en la base). Devuelve cuántos son nuevos."""
    ahora = ahora or datetime.now(timezone.utc)
    return conn.execute("SELECT detectar_avisos(%s, %s, %s, %s)", (hoy, ahora, dia_limite, recordatorio_dias)).fetchone()[0]


def entregar(conn: psycopg.Connection, canales: Sequence[Canal], url_base: str | None, hoy: date, ahora: datetime | None = None,
             dia_limite: int = DIA_LIMITE_PUBLICACION) -> Resultado:
    """Entrega los avisos pendientes por cada canal configurado; reintenta los que fallaron antes."""
    tomados = conn.execute("SELECT tomar_avisos(%s, %s, %s)", (hoy, dia_limite, RESERVA_SEGUNDOS)).fetchone()[0]
    enviados = fallidos = pendientes = 0
    errores: list[str] = []
    for aviso in tomados["avisos"]:
        mensaje = Mensaje(aviso["asunto"], aviso["cuerpo"], f"{url_base}{aviso['ruta']}" if url_base and aviso["ruta"] else None)
        entregas, completo = dict(aviso["entregas"]), True
        for canal in canales:
            if entregas.get(canal.nombre, {}).get("ok"):
                continue
            try:
                canal.enviar(mensaje)
                entregas[canal.nombre] = {"ok": True, "en": datetime.now(timezone.utc).isoformat()}
            except Exception as error:  # un canal roto no puede frenar a los demás ni al resto de la corrida
                texto = str(error) if isinstance(error, ErrorEnvio) else f"Falló la entrega ({type(error).__name__})"
                entregas[canal.nombre] = {"ok": False, "error": texto}
                errores.append(f"{canal.nombre}: {texto}")
                completo = False
        estado = conn.execute("SELECT registrar_entrega(%s, %s, %s)", (aviso["id"], Jsonb(entregas), completo)).fetchone()[0]
        enviados += estado == "enviado"
        fallidos += estado == "fallido"
        pendientes += estado == "pendiente"
    return Resultado(enviados=enviados, descartados=tomados["descartados"], fallidos=fallidos, pendientes=pendientes,
                     ocupado=tomados["en_curso"] > 0, errores=tuple(errores))


def procesar(conn: psycopg.Connection, canales: Sequence[Canal], url_base: str | None, hoy: date, ahora: datetime | None = None,
             dia_limite: int = DIA_LIMITE_PUBLICACION, recordatorio_dias: int = RECORDATORIO_DIAS) -> Resultado:
    """Detecta y entrega. Sin canales configurados no hace nada, ni siquiera registra: si no, al
    configurar uno después se enviaría de golpe todo lo que se fue acumulando."""
    if not canales:
        return Resultado()
    creados = detectar(conn, hoy, ahora, dia_limite, recordatorio_dias)
    resultado = entregar(conn, canales, url_base, hoy, ahora, dia_limite)
    return Resultado(creados, resultado.enviados, resultado.descartados, resultado.fallidos, resultado.pendientes, resultado.ocupado, resultado.errores)
