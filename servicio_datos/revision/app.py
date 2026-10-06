"""Interfaz de revisión: la cola de candidatos y la pantalla para revisarlos y publicarlos.

Es una app aparte de la web pública de ChartBay. Acá se escribe (aceptar, rechazar, publicar,
descartar), así que:

- Todo exige usuario y contraseña (HTTP Basic, con hashes en `DATOS_REVISORES`). El usuario
  autenticado es el `revisor` que queda registrado: no se puede poner otro nombre.
- Cada formulario lleva un token que solo conoce quien tiene sesión, y se rechaza un POST que
  venga de otro origen. Sin eso, una página ajena podría enviar un formulario con las
  credenciales que el navegador manda solo.
- Los intentos de acceso fallidos se frenan.
- Las respuestas llevan cabeceras estrictas y no se guardan en caché.

Funciona sin JavaScript. Va detrás de HTTPS: con Basic las credenciales viajan en cada pedido.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Callable, Mapping
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import psycopg
from flask import Flask, Response, abort, g, redirect, render_template, request, url_for
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash

from servicio_datos import publicacion
from servicio_datos.publicacion import ErrorPublicacion
from servicio_datos.revision import consultas, grafico

ZONA = ZoneInfo("America/Argentina/Buenos_Aires")
INTENTOS_MAXIMOS, VENTANA_SEGUNDOS = 5, 300

# Cómo se llama cada regla y qué significa, para quien revisa.
REGLAS: Mapping[str, tuple[str, str]] = {
    "salto_mensual": ("Salto mensual atípico", "El índice varió más que el umbral de un mes al siguiente. Puede ser un hecho real o un error de carga."),
    "fecha_normalizada": ("Encabezado de fecha normalizado", "Excel guardó un encabezado de mes con otro día; se interpretó como el mes. No cambia ningún valor."),
    "cobertura": ("Cobertura desigual", "Las series no terminan el mismo mes: suele pasar cuando un archivo está un mes atrás de otro."),
    "historia_intacta": ("Cambia un dato ya publicado", "Un valor publicado antes cambió o falta en el archivo nuevo. El IPC en general no se revisa."),
    "frescura": ("Datos más viejos de lo esperado", "Al día de hoy se esperaba un mes más reciente."),
    "cruce_regional": ("Nacional fuera del rango regional", "El índice nacional quedó fuera del rango que marcan las seis regiones."),
    "continuidad": ("Meses ausentes o repetidos", "Hay un mes que falta, se repite o está fuera de orden."),
    "rango": ("Valor fuera de rango", "Hay un índice cero, negativo o no numérico."),
    "estructura": ("Estructura del archivo", "Falta una serie esperada o apareció una que no corresponde."),
    "base_referencia": ("Base de referencia", "La serie ya no empieza en diciembre de 2016 con índice 100."),
}
# Cómo se muestra lo que propone el analista (ver servicio_datos/agente): clasificación, qué aconseja y con qué tono.
CLASIFICACIONES: Mapping[str, str] = {
    "dato_real": "Dato real", "cosmetico": "Cambio cosmético", "posible_error_de_carga": "Posible error de carga",
    "desfase_de_archivo": "Desfase de archivo", "cambio_de_base": "Posible cambio de base",
    "requiere_revision_humana": "Requiere revisión humana", "precedente": "Decisión previa de una persona",
}
SUGERENCIAS: Mapping[str, tuple[str, str]] = {
    "aceptar": ("Propone aceptar", "bueno"), "rechazar": ("Propone rechazar", "malo"), "investigar": ("Pide que lo mires", "aviso"),
}
ORDEN_SEVERIDAD = {"alta": 0, "media": 1, "baja": 2}
AVISOS = {
    "aceptado": "Hallazgo aceptado.",
    "rechazado": "Hallazgo rechazado. El candidato no se puede publicar mientras haya uno rechazado.",
    "grupo": "Hallazgos aceptados.",
    "publicado": "Candidato publicado.",
    "descartado": "Candidato descartado.",
}


def _clave_csrf(secreto: bytes, usuario: str) -> str:
    return hmac.new(secreto, f"csrf:{usuario}".encode(), hashlib.sha256).hexdigest()


def crear_app(
    url_base_datos: str,
    revisores: Mapping[str, str],
    conexion: Callable[[], psycopg.Connection] | None = None,
    confiar_en_proxy: bool = False,
) -> Flask:
    """`revisores`: usuario -> hash de contraseña (werkzeug). `conexion` solo se pasa en pruebas.

    `confiar_en_proxy`: detrás de un proxy con HTTPS (Caddy, nginx), toma de él la dirección del visitante, el
    esquema y el host. Solo se activa si hay UN proxy delante que pisa esas cabeceras y la app escucha únicamente
    en 127.0.0.1: si no, cualquiera podría falsear `X-Forwarded-For` y esquivar el límite de intentos.
    """
    if not revisores:
        raise ValueError("Hace falta al menos un revisor: sin autenticación esta interfaz no arranca")
    app = Flask(__name__)
    if confiar_en_proxy:
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)  # type: ignore[method-assign]
    secreto = hashlib.sha256("|".join(f"{u}={h}" for u, h in sorted(revisores.items())).encode()).digest()
    fallos: dict[tuple[str, str], list[float]] = {}

    def abrir() -> psycopg.Connection:
        return conexion() if conexion else psycopg.connect(url_base_datos, autocommit=True)

    # --- Seguridad --------------------------------------------------------

    def exigir_acceso() -> Response | None:
        credenciales = request.authorization
        clave_intentos = (request.remote_addr or "?", credenciales.username if credenciales else "")
        ahora = time.monotonic()
        recientes = [t for t in fallos.get(clave_intentos, []) if ahora - t < VENTANA_SEGUNDOS]
        if len(recientes) >= INTENTOS_MAXIMOS:
            respuesta = Response("Demasiados intentos. Esperá unos minutos.", 429)
            respuesta.headers["Retry-After"] = str(VENTANA_SEGUNDOS)
            return respuesta
        if credenciales and credenciales.username in revisores and check_password_hash(
            revisores[credenciales.username], credenciales.password or ""
        ):
            g.usuario = credenciales.username
            return None
        if credenciales:
            fallos[clave_intentos] = recientes + [ahora]
        respuesta = Response("Hace falta iniciar sesión.", 401)
        respuesta.headers["WWW-Authenticate"] = 'Basic realm="Revision de datos", charset="UTF-8"'
        return respuesta

    @app.before_request
    def antes() -> Response | None:
        if request.endpoint in ("salud", "static"):
            return None
        denegado = exigir_acceso()
        if denegado:
            return denegado
        if request.method == "POST":
            origen = request.headers.get("Origin")
            if origen and urlsplit(origen).netloc != request.host:
                # Se registra lo que llegó (no son secretos) para distinguir un ataque de un proxy mal configurado.
                app.logger.warning("POST rechazado por origen: Origin=%r Host=%r", origen, request.host)
                abort(403, "No se pudo verificar de qué página viene el pedido. Recargá la página e intentá de nuevo."
                      if origen == "null" else "El pedido viene de otro origen.")
            enviado = request.form.get("csrf", "")
            if not hmac.compare_digest(enviado, _clave_csrf(secreto, g.usuario)):
                abort(403, "Falta el token del formulario. Volvé a abrir la página y repetí la acción.")
        return None

    @app.after_request
    def cabeceras(respuesta: Response) -> Response:
        respuesta.headers["Content-Security-Policy"] = (
            "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; "
            "base-uri 'none'; frame-ancestors 'none'"
        )
        respuesta.headers["X-Content-Type-Options"] = "nosniff"
        # Nunca "no-referrer": con esa política los navegadores mandan `Origin: null` en los formularios
        # del propio sitio, y el chequeo de origen rechazaría a todos los usuarios. Con same-origin no
        # se filtra nada hacia afuera y el origen llega entero.
        respuesta.headers["Referrer-Policy"] = "same-origin"
        respuesta.headers["X-Frame-Options"] = "DENY"
        if request.endpoint != "static":
            respuesta.headers["Cache-Control"] = "no-store"
        if request.is_secure:
            # Solo por HTTPS (HSTS por HTTP no vale y fijaría al navegador a un sitio que quizá no lo tenga).
            # Sin includeSubDomains: el dominio puede tener otras cosas que todavía no sirven por HTTPS.
            respuesta.headers["Strict-Transport-Security"] = "max-age=31536000"
        return respuesta

    @app.teardown_request
    def cerrar(_error: BaseException | None) -> None:
        conn = g.pop("conn", None)
        if conn is not None:
            conn.close()

    def conn() -> psycopg.Connection:
        if "conn" not in g:
            g.conn = abrir()
        return g.conn

    @app.context_processor
    def contexto() -> dict:
        usuario = g.get("usuario")
        return {"usuario": usuario, "csrf": _clave_csrf(secreto, usuario) if usuario else "", "reglas": REGLAS,
                "clasificaciones": CLASIFICACIONES, "sugerencias": SUGERENCIAS}

    # --- Formato ----------------------------------------------------------

    def _local(momento: datetime | None) -> datetime | None:
        return momento.astimezone(ZONA) if momento else None

    @app.template_filter("fecha")
    def fecha(momento: datetime | None) -> str:
        local = _local(momento)
        return f"{local.day} {grafico.MESES[local.month - 1]} {local.year}, {local:%H:%M}" if local else "—"

    @app.template_filter("hace")
    def hace(momento: datetime | None) -> str:
        if momento is None:
            return "—"
        segundos = max(int((datetime.now(timezone.utc) - momento).total_seconds()), 0)
        for singular, plural, tamano in (("día", "días", 86400), ("hora", "horas", 3600), ("minuto", "minutos", 60)):
            if segundos >= tamano:
                n = segundos // tamano
                return f"hace {n} {singular if n == 1 else plural}"
        return "hace instantes"

    app.jinja_env.filters["num4"] = lambda v: grafico.numero(v, 4)
    app.jinja_env.filters["entero"] = lambda v: grafico.numero(v, 0)
    app.jinja_env.filters["mes"] = lambda p: grafico.mes(p) if p else "—"
    app.jinja_env.filters["hash_corto"] = lambda h: (h or "")[:10]

    # --- Pantallas --------------------------------------------------------

    @app.get("/salud")
    def salud() -> Response:
        return Response("ok", mimetype="text/plain")

    @app.get("/")
    def cola() -> str:
        ver = request.args.get("ver", "atencion")
        if ver not in ("atencion", "historial", "todo"):
            ver = "atencion"
        c = conn()
        abiertos, fallidas, hist = consultas.candidatos_abiertos(c), consultas.corridas_fallidas(c), consultas.historial(c)
        return render_template("cola.html", ver=ver, resumen=consultas.resumen(c), abiertos=abiertos, fallidas=fallidas,
                               historial=hist, cuentas={"atencion": len(abiertos) + len(fallidas), "historial": len(hist),
                                                        "todo": len(abiertos) + len(fallidas) + len(hist)})

    def _pagina_candidato(candidato_id: int, error: str | None = None, aviso: str | None = None, estado: int = 200,
                          valores: Mapping[str, str] | None = None) -> tuple[str, int]:
        c = conn()
        cand = consultas.candidato(c, candidato_id)
        if cand is None:
            abort(404)
        lista = consultas.hallazgos(c, candidato_id)
        abierto = cand["estado"] == "abierto"
        diff = consultas.diferencias(c, candidato_id) if abierto else None
        series = consultas.series_para_graficos(c, candidato_id, sorted({h["serie_id"] for h in lista if h["serie_id"]}))
        grupos: dict[str, list[dict]] = {}
        for h in lista:
            grafico_svg = ""
            if h["serie_id"] and series[h["serie_id"]]["candidato"]:
                datos = series[h["serie_id"]]
                grafico_svg = grafico.linea(
                    grafico.ventana(datos["candidato"], h["periodo"]), grafico.ventana(datos["vigente"], h["periodo"]) or None,
                    h["periodo"], titulo=f"{h['serie_nombre'] or h['serie_id']}", uid=f"h{h['id']}")
            grupos.setdefault(h["regla"], []).append({**h, "grafico": grafico_svg})
        ordenados = sorted(grupos.items(), key=lambda kv: (min(ORDEN_SEVERIDAD[h["severidad"]] for h in kv[1]), kv[0]))
        # Lo que el analista propone sobre lo que sigue sin resolver, para verlo de un vistazo.
        sin_resolver = [h for g in grupos.values() for h in g if not h["decision"]]
        sugeridas = [p["accion_sugerida"] for h in sin_resolver for p in h["propuestas"] if p["accion_sugerida"]]
        analisis = {"sin_resolver": len(sin_resolver), **{a: sugeridas.count(a) for a in SUGERENCIAS}} if sugeridas else None
        revision = publicacion.estado_revision(c, candidato_id)
        archivos = consultas.archivos_de_corrida(c, cand["corrida_id"])
        html = render_template(
            "candidato.html", c=cand, grupos=ordenados, revision=revision, diff=diff, archivos=archivos, abierto=abierto, analisis=analisis,
            error=error, aviso=AVISOS.get(aviso or ""), valores=valores or {}, n_aviso=request.args.get("n", type=int))
        return html, estado

    @app.get("/candidatos/<int:candidato_id>")
    def candidato(candidato_id: int) -> tuple[str, int]:
        return _pagina_candidato(candidato_id, aviso=request.args.get("ok"))

    @app.get("/corridas/<int:corrida_id>")
    def corrida(corrida_id: int) -> str:
        c = conn()
        fila = consultas.corrida(c, corrida_id)
        if fila is None:
            abort(404)
        return render_template("corrida.html", corrida=fila, archivos=consultas.archivos_de_corrida(c, corrida_id))

    # --- Acciones ---------------------------------------------------------

    def _ok(candidato_id: int, codigo: str, **extra: int) -> Response:
        return redirect(url_for("candidato", candidato_id=candidato_id, ok=codigo, **extra), code=303)

    def _rechazo(candidato_id: int, error: ErrorPublicacion, **valores: str) -> tuple[str, int]:
        estado = 409 if error.codigo in ("no_abierto", "candidato_cerrado") else 422
        return _pagina_candidato(candidato_id, error=str(error), estado=estado, valores=valores)

    def _existe(candidato_id: int) -> None:
        if consultas.candidato(conn(), candidato_id) is None:
            abort(404)

    @app.post("/candidatos/<int:candidato_id>/revisar")
    def revisar(candidato_id: int):
        _existe(candidato_id)
        decision = {"aceptar": "aceptado", "rechazar": "rechazado"}.get(request.form.get("accion", ""))
        hallazgo_id = request.form.get("hallazgo", type=int)
        comentario = request.form.get("comentario", "").strip()
        if decision is None or hallazgo_id is None or not consultas.hallazgo_pertenece(conn(), candidato_id, hallazgo_id):
            abort(400)
        try:
            publicacion.revisar_hallazgo(conn(), hallazgo_id, decision, g.usuario, comentario or None)
        except ErrorPublicacion as error:
            mensaje = "Para rechazar escribí por qué." if decision == "rechazado" and not comentario else str(error)
            return _rechazo(candidato_id, ErrorPublicacion(error.codigo, mensaje), **{f"comentario-{hallazgo_id}": comentario})
        return _ok(candidato_id, decision)

    @app.post("/candidatos/<int:candidato_id>/aceptar-pendientes")
    def aceptar_pendientes(candidato_id: int):
        """Acepta de una vez los hallazgos sin decisión: los de una regla, o todos si no se indica."""
        _existe(candidato_id)
        regla = request.form.get("regla") or None
        if regla is not None and regla not in REGLAS:
            abort(400)
        comentario = request.form.get("comentario", "").strip() or "Revisado"
        ids = consultas.hallazgos_pendientes(conn(), candidato_id, regla)
        try:
            with conn().transaction():  # todos o ninguno
                for hallazgo_id in ids:
                    publicacion.revisar_hallazgo(conn(), hallazgo_id, "aceptado", g.usuario, comentario)
        except ErrorPublicacion as error:
            return _rechazo(candidato_id, error)
        return _ok(candidato_id, "grupo", n=len(ids))

    @app.post("/candidatos/<int:candidato_id>/publicar")
    def publicar(candidato_id: int):
        _existe(candidato_id)
        try:
            publicacion.publicar_candidato(conn(), candidato_id, g.usuario)
        except ErrorPublicacion as error:
            return _rechazo(candidato_id, error)
        return _ok(candidato_id, "publicado")

    @app.post("/candidatos/<int:candidato_id>/descartar")
    def descartar(candidato_id: int):
        _existe(candidato_id)
        motivo = request.form.get("motivo", "").strip()
        try:
            publicacion.descartar_candidato(conn(), candidato_id, g.usuario, motivo)
        except ErrorPublicacion as error:
            mensaje = "Para descartar el candidato escribí el motivo." if error.codigo == "descarte_incompleto" else str(error)
            return _rechazo(candidato_id, ErrorPublicacion(error.codigo, mensaje), motivo=motivo)
        return _ok(candidato_id, "descartado")

    @app.errorhandler(400)
    @app.errorhandler(403)
    @app.errorhandler(404)
    def error_http(error) -> tuple[str, int]:
        mensajes = {400: "El pedido no es válido.", 403: getattr(error, "description", "No permitido."), 404: "No encontramos eso."}
        return render_template("error.html", codigo=error.code, mensaje=mensajes.get(error.code, "Error")), error.code

    @app.errorhandler(psycopg.OperationalError)
    def base_no_disponible(error) -> tuple[str, int]:
        # Solo el tipo: el mensaje del driver puede traer el host o el usuario de la base.
        app.logger.error("La base de datos no responde (%s)", type(error).__name__)
        return render_template("error.html", codigo=503, mensaje="No se pudo conectar con la base de datos. Probá de nuevo en un momento."), 503

    return app
