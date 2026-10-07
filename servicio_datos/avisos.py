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
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Callable, Sequence
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from servicio_datos.canales import Canal, ErrorEnvio, Mensaje
from servicio_datos.ipc.validacion import DIA_LIMITE_PUBLICACION

MAX_INTENTOS = 5
RECORDATORIO_DIAS = 3  # primer recordatorio de un candidato abierto; 0 los desactiva
INACTIVIDAD_DIAS = 2  # el colector corre por lo menos una vez por día
RESPALDO_ATRASO_DIAS = 2  # el respaldo corre una vez por día
CANDADO = 727275  # pg_try_advisory_lock: una sola entrega a la vez
ZONA = ZoneInfo("America/Argentina/Buenos_Aires")
MESES = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre")


@dataclass(frozen=True)
class Resultado:
    creados: int = 0
    enviados: int = 0
    descartados: int = 0
    fallidos: int = 0  # se agotaron los intentos
    pendientes: int = 0  # siguen esperando un reintento
    ocupado: bool = False  # otra corrida de avisos estaba entregando
    errores: tuple[str, ...] = ()  # por canal, sin secretos


def _cantidad(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def _mes(periodo: date) -> str:
    return f"{MESES[periodo.month - 1]} {periodo.year}"


def _fecha(momento: datetime) -> str:
    local = momento.astimezone(ZONA)
    return f"{local.day} de {MESES[local.month - 1]}, {local:%H:%M}"


def _filas(conn: psycopg.Connection, sql: str, params: Sequence | dict = ()) -> list[dict]:
    with conn.cursor(row_factory=dict_row) as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def _esperado(hoy: date, dia_limite: int) -> date:
    """El primer mes de datos que ya debería haber llegado: igual que la regla de frescura de la validación."""
    indice = hoy.year * 12 + hoy.month - 1 - (1 if hoy.day > dia_limite else 2)
    return date(indice // 12, indice % 12 + 1, 1)


def _ultimo_periodo(conn: psycopg.Connection, fuente_id: str) -> date | None:
    """El período más nuevo que se conoce de la fuente: lo publicado o lo de un candidato abierto."""
    return conn.execute(
        "SELECT max(p) FROM (SELECT o.periodo AS p FROM observacion_vigente o JOIN serie s ON s.id = o.serie_id WHERE s.fuente_id = %(f)s "
        " UNION ALL SELECT oc.periodo FROM observacion_candidata oc JOIN candidato c ON c.id = oc.candidato_id "
        " JOIN corrida co ON co.id = c.corrida_id WHERE co.fuente_id = %(f)s AND c.estado = 'abierto') t",
        {"f": fuente_id},
    ).fetchone()[0]


def hito_de_recordatorio(edad_dias: int, primero: int = RECORDATORIO_DIAS) -> int | None:
    """El hito de recordatorio que corresponde a un candidato con esa edad, o None si todavía no toca.

    El primero a los `primero` días, y después uno por semana (7, 14, 21...). Si el sistema estuvo
    apagado solo cuenta el hito más alto alcanzado: no se manda de golpe lo que se acumuló.
    """
    if primero <= 0 or edad_dias < primero:
        return None
    return primero if edad_dias < 7 else max(primero, 7 * (edad_dias // 7))


def _detectar_recordatorios(conn: psycopg.Connection, ahora: datetime, recordatorio_dias: int = RECORDATORIO_DIAS, **_) -> int:
    creados = 0
    if recordatorio_dias <= 0:
        return creados
    for c in _filas(
        conn,
        "SELECT c.id, c.creado_en, co.fuente_id, f.nombre, count(h.id) AS hallazgos, "
        " count(*) FILTER (WHERE u.decision = 'aceptado') AS aceptados, count(*) FILTER (WHERE u.decision = 'rechazado') AS rechazados, "
        " count(h.id) FILTER (WHERE u.decision IS NULL) AS pendientes "
        "FROM candidato c JOIN corrida co ON co.id = c.corrida_id JOIN fuente f ON f.id = co.fuente_id "
        "LEFT JOIN hallazgo h ON h.corrida_id = c.corrida_id "
        "LEFT JOIN LATERAL (SELECT decision FROM revision_hallazgo r WHERE r.hallazgo_id = h.id ORDER BY r.id DESC LIMIT 1) u ON true "
        "WHERE c.estado = 'abierto' GROUP BY c.id, co.id, f.id ORDER BY c.id",
    ):
        edad = (ahora - c["creado_en"]).days
        hito = hito_de_recordatorio(edad, recordatorio_dias)
        if hito is None:
            continue
        if c["rechazados"]:
            situacion = (f"Tiene {_cantidad(c['rechazados'], 'hallazgo rechazado', 'hallazgos rechazados')}: "
                         "con rechazos no se puede publicar, hay que descartarlo y esperar el próximo.")
        elif c["pendientes"]:
            situacion = f"Faltan resolver {c['pendientes']} de {c['hallazgos']} hallazgos."
        else:
            situacion = "Todos los hallazgos están resueltos: está listo para publicar." if c["hallazgos"] else "No tiene hallazgos: está listo para publicar."
        creados += _insertar(
            conn, f"candidato_pendiente:{c['id']}:{hito}", "candidato_pendiente", c["fuente_id"], str(c["id"]),
            f"{'[Atención]' if edad >= 14 else '[Recordatorio]'} Candidato {c['id']} lleva {edad} días sin cerrarse ({c['fuente_id']})",
            f"El candidato {c['id']} de {c['nombre']} se creó el {_fecha(c['creado_en'])} y sigue abierto, hace {edad} días.\n{situacion}\n"
            "Mientras tanto ChartBay sigue mostrando la versión anterior.", f"/candidatos/{c['id']}")
    return creados


_SIN_RESOLVER = ("NOT EXISTS (SELECT 1 FROM corrida c2 WHERE c2.fuente_id = c.fuente_id AND c2.id > c.id "
                 "AND c2.estado IN ('sin_cambios', 'con_candidato'))")


def _insertar(conn: psycopg.Connection, clave: str, tipo: str, fuente_id: str | None, referencia: str, asunto: str, cuerpo: str, ruta: str | None) -> int:
    return conn.execute(
        "INSERT INTO aviso (clave, tipo, fuente_id, referencia, asunto, cuerpo, ruta) VALUES (%s, %s, %s, %s, %s, %s, %s) "
        "ON CONFLICT (clave) DO NOTHING",
        (clave, tipo, fuente_id, referencia, asunto, cuerpo, ruta),
    ).rowcount


def _detectar_candidatos(conn: psycopg.Connection, **_) -> int:
    creados = 0
    for c in _filas(
        conn,
        "SELECT c.id, c.creado_en, co.fuente_id, f.nombre, co.resumen, count(h.id) AS hallazgos, "
        " count(h.id) FILTER (WHERE h.severidad = 'alta') AS altas "
        "FROM candidato c JOIN corrida co ON co.id = c.corrida_id JOIN fuente f ON f.id = co.fuente_id "
        "LEFT JOIN hallazgo h ON h.corrida_id = c.corrida_id WHERE c.estado = 'abierto' "
        "AND NOT EXISTS (SELECT 1 FROM aviso a WHERE a.clave = 'candidato_nuevo:' || c.id) GROUP BY c.id, co.id, f.id ORDER BY c.id",
    ):
        r = c["resumen"]
        nuevos, cambian, faltan = r.get("periodos_nuevos", 0), r.get("periodos_cambiados", 0), r.get("periodos_faltantes", 0)
        urgente = bool(cambian or faltan or c["altas"])
        lineas = [f"Candidato {c['id']} de {c['nombre']} ({c['fuente_id']}), creado el {_fecha(c['creado_en'])}.",
                  f"Respecto de lo publicado: {_cantidad(nuevos, 'período nuevo', 'períodos nuevos')}, "
                  f"{_cantidad(cambian, 'dato ya publicado que cambia', 'datos ya publicados que cambian')}, "
                  f"{_cantidad(faltan, 'que falta', 'que faltan')}."]
        lineas.append(f"Hallazgos para revisar: {c['hallazgos']}" + (f" ({c['altas']} de severidad alta)" if c["altas"] else "") + "."
                      if c["hallazgos"] else "No tiene hallazgos.")
        if r.get("hallazgos_ya_revisados"):
            lineas.append(f"Otros {r['hallazgos_ya_revisados']} ya se revisaron en una publicación anterior y no se repiten.")
        creados += _insertar(conn, f"candidato_nuevo:{c['id']}", "candidato_nuevo", c["fuente_id"], str(c["id"]),
                             f"{'[Atención] ' if urgente else ''}Candidato {c['id']} para revisar ({c['fuente_id']})", "\n".join(lineas), f"/candidatos/{c['id']}")
    return creados


def _detectar_fallidas(conn: psycopg.Connection, **_) -> int:
    creados = 0
    # Una vez por racha: la corrida fallida más vieja sin resolver de cada fuente.
    for c in _filas(
        conn,
        f"SELECT DISTINCT ON (c.fuente_id) c.id, c.fuente_id, f.nombre, c.iniciada_en, c.error FROM corrida c JOIN fuente f ON f.id = c.fuente_id "
        f"WHERE c.estado = 'fallida' AND {_SIN_RESOLVER} ORDER BY c.fuente_id, c.id",
    ):
        error = " ".join((c["error"] or "Sin detalle").split())[:300]
        creados += _insertar(
            conn, f"corrida_fallida:{c['id']}", "corrida_fallida", c["fuente_id"], str(c["id"]),
            f"[Atención] Falló la corrida {c['id']} ({c['fuente_id']})",
            f"La corrida {c['id']} de {c['nombre']} falló el {_fecha(c['iniciada_en'])}:\n{error}\n"
            "Mientras no termine bien una corrida posterior, no se vuelve a avisar de esta falla. Reintentar es manual.", f"/corridas/{c['id']}")
    return creados


def _detectar_sin_datos(conn: psycopg.Connection, hoy: date, dia_limite: int, **_) -> int:
    creados, esperado = 0, _esperado(hoy, dia_limite)
    for f in _filas(conn, "SELECT id, nombre FROM fuente WHERE EXISTS (SELECT 1 FROM corrida WHERE fuente_id = fuente.id)"):
        ultimo = _ultimo_periodo(conn, f["id"])
        if ultimo is None or ultimo >= esperado:  # sin datos todavía no hay nada que se haya atrasado
            continue
        creados += _insertar(
            conn, f"sin_datos:{f['id']}:{esperado:%Y-%m}", "sin_datos", f["id"], f"{esperado:%Y-%m}",
            f"[Atención] No llegaron los datos de {_mes(esperado)} ({f['id']})",
            f"Al {hoy.day} de {MESES[hoy.month - 1]} lo más nuevo que hay de {f['nombre']} es {_mes(ultimo)}, y ya se esperaba al menos {_mes(esperado)} "
            "(ni lo publicado ni ningún candidato abierto lo cubren).\nRevisá si la fuente publicó y si el colector está corriendo.", "/")
    return creados


def _detectar_inactivo(conn: psycopg.Connection, ahora: datetime, **_) -> int:
    creados = 0
    for c in _filas(conn, "SELECT DISTINCT ON (c.fuente_id) c.id, c.fuente_id, f.nombre, c.iniciada_en FROM corrida c JOIN fuente f ON f.id = c.fuente_id ORDER BY c.fuente_id, c.id DESC"):
        dias = (ahora - c["iniciada_en"]).days
        if dias < INACTIVIDAD_DIAS:
            continue
        creados += _insertar(
            conn, f"colector_inactivo:{c['fuente_id']}:{c['id']}", "colector_inactivo", c["fuente_id"], str(c["id"]),
            f"[Atención] El colector de {c['fuente_id']} no corre desde hace {dias} días",
            f"La última corrida de {c['nombre']} fue la {c['id']}, el {_fecha(c['iniciada_en'])} (hace {dias} días).\n¿Está funcionando el cron que la dispara?", "/")
    return creados


def _detectar_respaldos(conn: psycopg.Connection, ahora: datetime, **_) -> int:
    ultimo = _filas(conn, "SELECT id, ok, iniciado_en, error FROM respaldo ORDER BY id DESC LIMIT 1")
    if not ultimo:  # el respaldo todavía no se configuró
        return 0
    creados, ultimo = 0, ultimo[0]
    bueno = _filas(conn, "SELECT id, iniciado_en FROM respaldo WHERE ok ORDER BY id DESC LIMIT 1")
    if not ultimo["ok"]:
        # Una vez por racha: la primera falla después del último respaldo bueno.
        primera = conn.execute("SELECT min(id) FROM respaldo WHERE id > %s", (bueno[0]["id"] if bueno else 0,)).fetchone()[0]
        error = " ".join((ultimo["error"] or "Sin detalle").split())[:400]
        creados += _insertar(
            conn, f"respaldo_fallido:{primera}", "respaldo_fallido", None, str(primera), "[Atención] Falló el respaldo de la base o del crudo",
            f"El respaldo del {_fecha(ultimo['iniciado_en'])} falló:\n{error}\n"
            "Mientras no salga bien uno posterior, no se vuelve a avisar de esta falla. El detalle: python -m servicio_datos.respaldar estado", None)
    desde = bueno[0]["iniciado_en"] if bueno else conn.execute("SELECT min(iniciado_en) FROM respaldo").fetchone()[0]
    dias = (ahora - desde).days
    if dias >= RESPALDO_ATRASO_DIAS:
        referencia = str(bueno[0]["id"]) if bueno else "0"
        cuando = f"el último bueno es del {_fecha(desde)}" if bueno else "nunca salió bien uno"
        creados += _insertar(
            conn, f"respaldo_atrasado:{referencia}", "respaldo_atrasado", None, referencia, f"[Atención] No hay un respaldo bueno hace {dias} días",
            f"Los respaldos de la base y del crudo corren una vez por día y {cuando}.\n"
            "¿Está corriendo el cron? ¿Está montado el disco de destino? El detalle: python -m servicio_datos.respaldar estado", None)
    return creados


DETECTORES: Sequence[Callable[..., int]] = (_detectar_candidatos, _detectar_recordatorios, _detectar_fallidas, _detectar_sin_datos, _detectar_inactivo,
                                            _detectar_respaldos)


def detectar(conn: psycopg.Connection, hoy: date, ahora: datetime | None = None, dia_limite: int = DIA_LIMITE_PUBLICACION,
             recordatorio_dias: int = RECORDATORIO_DIAS) -> int:
    """Registra los avisos que falten. Devuelve cuántos son nuevos."""
    ahora = ahora or datetime.now(timezone.utc)
    return sum(d(conn, hoy=hoy, ahora=ahora, dia_limite=dia_limite, recordatorio_dias=recordatorio_dias) for d in DETECTORES)


def _sigue_siendo_cierto(conn: psycopg.Connection, aviso: dict, hoy: date, ahora: datetime, dia_limite: int) -> bool:
    """Antes de entregar: un candidato ya resuelto o un dato que ya llegó no merecen un aviso tardío."""
    tipo, ref, fuente_id = aviso["tipo"], aviso["referencia"], aviso["fuente_id"]
    if tipo in ("candidato_nuevo", "candidato_pendiente"):
        return conn.execute("SELECT estado = 'abierto' FROM candidato WHERE id = %s", (int(ref),)).fetchone()[0]
    if tipo == "corrida_fallida":
        return conn.execute(f"SELECT {_SIN_RESOLVER} FROM corrida c WHERE c.id = %s", (int(ref),)).fetchone()[0]
    if tipo == "sin_datos":
        ultimo = _ultimo_periodo(conn, fuente_id)
        return ultimo is not None and ultimo < _esperado(hoy, dia_limite)
    if tipo == "colector_inactivo":
        return conn.execute("SELECT max(id) = %s FROM corrida WHERE fuente_id = %s", (int(ref), fuente_id)).fetchone()[0]
    if tipo == "respaldo_fallido":
        return conn.execute("SELECT NOT ok FROM respaldo ORDER BY id DESC LIMIT 1").fetchone()[0]
    if tipo == "respaldo_atrasado":  # mientras no haya uno bueno más nuevo que el que se nombró
        return conn.execute("SELECT coalesce(max(id), 0) = %s FROM respaldo WHERE ok", (int(ref),)).fetchone()[0]
    return True


def entregar(conn: psycopg.Connection, canales: Sequence[Canal], url_base: str | None, hoy: date, ahora: datetime | None = None,
             dia_limite: int = DIA_LIMITE_PUBLICACION) -> Resultado:
    """Entrega los avisos pendientes por cada canal configurado; reintenta los que fallaron antes."""
    ahora = ahora or datetime.now(timezone.utc)
    if not conn.execute("SELECT pg_try_advisory_lock(%s)", (CANDADO,)).fetchone()[0]:
        return Resultado(ocupado=True)
    enviados = descartados = fallidos = pendientes = 0
    errores: list[str] = []
    try:
        for aviso in _filas(conn, "SELECT * FROM aviso WHERE estado = 'pendiente' ORDER BY id"):
            if not _sigue_siendo_cierto(conn, aviso, hoy, ahora, dia_limite):
                conn.execute("UPDATE aviso SET estado = 'descartado' WHERE id = %s", (aviso["id"],))
                descartados += 1
                continue
            mensaje = Mensaje(aviso["asunto"], aviso["cuerpo"], f"{url_base}{aviso['ruta']}" if url_base and aviso["ruta"] else None)
            entregas, completo = dict(aviso["entregas"]), True
            for canal in canales:
                previo = entregas.get(canal.nombre, {})
                if previo.get("ok"):
                    continue
                try:
                    canal.enviar(mensaje)
                    entregas[canal.nombre] = {"ok": True, "en": datetime.now(timezone.utc).isoformat()}
                except Exception as error:  # un canal roto no puede frenar a los demás ni al resto de la corrida
                    texto = str(error) if isinstance(error, ErrorEnvio) else f"Falló la entrega ({type(error).__name__})"
                    entregas[canal.nombre] = {"ok": False, "error": texto}
                    errores.append(f"{canal.nombre}: {texto}")
                    completo = False
            intentos = aviso["intentos"] + 1
            estado = "enviado" if completo else ("fallido" if intentos >= MAX_INTENTOS else "pendiente")
            conn.execute("UPDATE aviso SET estado = %s, intentos = %s, entregas = %s, enviado_en = CASE WHEN %s = 'enviado' THEN now() END WHERE id = %s",
                         (estado, intentos, Jsonb(entregas), estado, aviso["id"]))
            enviados += estado == "enviado"
            fallidos += estado == "fallido"
            pendientes += estado == "pendiente"
    finally:
        conn.execute("SELECT pg_advisory_unlock(%s)", (CANDADO,))
    return Resultado(enviados=enviados, descartados=descartados, fallidos=fallidos, pendientes=pendientes, errores=tuple(errores))


def procesar(conn: psycopg.Connection, canales: Sequence[Canal], url_base: str | None, hoy: date, ahora: datetime | None = None,
             dia_limite: int = DIA_LIMITE_PUBLICACION, recordatorio_dias: int = RECORDATORIO_DIAS) -> Resultado:
    """Detecta y entrega. Sin canales configurados no hace nada, ni siquiera registra: si no, al
    configurar uno después se enviaría de golpe todo lo que se fue acumulando."""
    if not canales:
        return Resultado()
    creados = detectar(conn, hoy, ahora, dia_limite, recordatorio_dias)
    resultado = entregar(conn, canales, url_base, hoy, ahora, dia_limite)
    return Resultado(creados, resultado.enviados, resultado.descartados, resultado.fallidos, resultado.pendientes, resultado.ocupado, resultado.errores)
