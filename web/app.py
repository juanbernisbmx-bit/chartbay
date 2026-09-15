"""
ChartBay Engine — motor web de cálculo para econometría y finanzas cuantitativas.
Reutiliza los módulos del pipeline (data, indicators, analyze) del proyecto.

Arrancar en local:
    pip install -r requirements.txt
    python web/app.py
    -> abre http://127.0.0.1:5000
"""
import json
import io
import os
import re
import secrets
import sqlite3
import sys
import tempfile
import threading
import time
from collections import defaultdict
from datetime import date, datetime
from functools import wraps
from pathlib import Path
from urllib.parse import urlparse

from dotenv import load_dotenv
from flask import (
    Flask, Response, abort, g, jsonify, redirect, render_template, request, send_file,
    session, url_for,
)
from werkzeug.security import generate_password_hash, check_password_hash

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))  # permite 'import db' bajo gunicorn (web/ en el path)
load_dotenv(ROOT / ".env")

import config           # noqa: E402
import data             # noqa: E402
import indicators       # noqa: E402
import db               # noqa: E402
import providers        # noqa: E402
from seed_data import BOTS_BASE  # noqa: E402
from source_archive import build_source_archive  # noqa: E402

CACHE_DIR = Path(__file__).resolve().parent / "cache"
CACHE_DIR.mkdir(exist_ok=True)
REPORTS_DIR = ROOT / config.OUTPUT_DIR


def write_atomic(fp: Path, text: str) -> None:
    """Escribe el archivo completo o no lo escribe: nunca deja un JSON a medias.

    Gunicorn corre con hilos, así que dos requests pueden cachear la misma clave
    al mismo tiempo. Con `fp.write_text()` la segunda trunca el archivo y lo
    reescribe, y una tercera que lea justo en el medio se lleva un JSON cortado.
    Acá cada llamada escribe en su propio temporal —en el mismo directorio, que
    es lo que hace que `os.replace` sea atómico— y recién al final lo mueve
    sobre el destino. Los lectores ven siempre la versión vieja o la nueva,
    nunca una intermedia. Si dos escriben a la vez gana la última, que para una
    caché de contenido equivalente da igual.
    """
    tmp_fd, tmp_name = tempfile.mkstemp(dir=str(fp.parent), prefix=f".{fp.name}.", suffix=".tmp")
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp_name, fp)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


app = Flask(__name__)


# ─── Secciones activas ───────────────────────────────────────────────────────
# Espejo en Python de CHARTBAY_VERTICALS (quantbay/src/verticals/agro/
# agroFeatureFlags.ts), que hace lo mismo del lado del navegador.
#
# Apagar una sección acá la desenchufa sin borrar nada: sus rutas pasan a
# devolver 404 y sus enlaces desaparecen del menú, pero las vistas y las
# plantillas siguen en el repo. Mercados sólo admite un override local de QA;
# no se considera reactivado ni soportado por cambiar este diccionario.
#
# Se define antes que nada porque de acá cuelga el resto del arranque: qué
# credenciales hacen falta, si se abre la base y qué permisos lleva el CSP.
#
# Las plantillas de las secciones apagadas se conservan para auditoría. Son
# inalcanzables mientras el flag esté en False; una reactivación futura exige
# revisar sus flujos completos, no solamente cambiar este diccionario.
SECCIONES = {
    "econometria": True,
    "limpiador": True,
    # Escondida por ahora: sin pestaña ni enlaces y con sus rutas en 404. El
    # código, la plantilla y los tests siguen (los tests la encienden).
    "datos": False,
    "agro": False,
    "mercados": False,
}


def _aplicar_overrides(seccion_env: str) -> None:
    """Permite encender Mercados para QA local, sin cambiar el alcance de 1.0.

    Formato: ``CHARTBAY_SECCIONES=mercados=on``. El override existe para probar
    rutas, autenticación y headers del código heredado. No habilita Agro ni
    permite apagar las secciones de 1.0, y tampoco convierte Mercados en una
    sección soportada: todavía requiere credenciales, persistencia y una revisión
    funcional separada antes de cualquier despliegue.

    El default no cambia. Cualquier otro nombre se ignora para que una variable
    de entorno no pueda ampliar o reducir accidentalmente el alcance publicado.
    """
    for par in seccion_env.split(","):
        nombre, _, valor = par.partition("=")
        nombre = nombre.strip().lower()
        if nombre == "mercados":
            SECCIONES["mercados"] = valor.strip().lower() in (
                "1", "true", "on", "si", "sí", "yes"
            )


_aplicar_overrides(os.environ.get("CHARTBAY_SECCIONES", ""))

# La sesión existe por una sola razón: la comunidad de bots de Mercados, que es
# lo único que tiene autor, login y contenido propio de cada usuario. Las
# secciones de 1.0 (Econometría, Limpiador, Datos, Documentación) calculan todo
# en el navegador y no guardan nada, así que con Mercados apagado no hay ni una
# ruta activa que mire `session`.
#
# De ese hecho cuelgan cuatro consecuencias, todas condicionadas acá y no
# repetidas por el archivo: no se piden credenciales al arrancar, no se abre
# SQLite, /login y /register devuelven 404, y la barra superior no ofrece
# "Entrar". El override de QA de Mercados devuelve esas superficies para
# probarlas, pero no garantiza que el vertical heredado esté operativo.
AUTH_ENABLED = SECCIONES["mercados"]


def seccion(nombre: str):
    """Deja la vista fuera de servicio (404) mientras su sección esté apagada."""
    def decorador(fn):
        @wraps(fn)
        def envoltura(*args, **kwargs):
            if not SECCIONES.get(nombre, False):
                abort(404)
            return fn(*args, **kwargs)
        return envoltura
    return decorador


def solo_con_auth(fn):
    """404 para las rutas de sesión mientras la autenticación esté apagada.

    Mismo criterio que `seccion`, pero colgado de AUTH_ENABLED: sin secciones
    que necesiten login, un formulario de acceso es una superficie de ataque
    que no le sirve a nadie.
    """
    @wraps(fn)
    def envoltura(*args, **kwargs):
        if not AUTH_ENABLED:
            abort(404)
        return fn(*args, **kwargs)
    return envoltura


# _is_dev must be defined before credential checks so both SECRET_KEY and APP_PASSWORD
# can decide whether to fail fast or use a local dev fallback.
_is_dev = os.environ.get("APP_ENV", "").lower() in ("development", "dev") or \
          os.environ.get("FLASK_ENV", "").lower() == "development"

_secret_key = os.environ.get("SECRET_KEY", "")
if not _secret_key:
    if _is_dev:
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "SECRET_KEY no configurado — usando clave de desarrollo local. "
            "Definí SECRET_KEY antes de desplegar en producción."
        )
        _secret_key = "dev-inseguro-cambiar"
    else:
        raise RuntimeError(
            "SECRET_KEY no está configurado. "
            "En Render se genera automáticamente con generateValue: true. "
            "Si desplegás en otro entorno, definí esta variable antes de iniciar la app."
        )
app.secret_key = _secret_key

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Secure fuera de desarrollo: sin esto la cookie de sesión viaja también por
    # HTTP y basta un enlace en texto plano para filtrarla. En local se apaga
    # porque el servidor de desarrollo no habla HTTPS y el navegador
    # descartaría la cookie, dejando el login inutilizable.
    SESSION_COOKIE_SECURE=not _is_dev,
)

APP_USERNAME = os.environ.get("APP_USERNAME", "juan")

_raw_pw = os.environ.get("APP_PASSWORD", "")
if not _raw_pw:
    if not AUTH_ENABLED:
        # Sin secciones que pidan sesión no hay usuario que sembrar, así que
        # exigir la contraseña acá solo lograba que un Blueprint recién creado
        # no arrancara por una credencial que nada iba a usar.
        APP_PASSWORD = ""
    elif _is_dev:
        import logging as _logging
        _logging.getLogger(__name__).warning(
            "APP_PASSWORD no configurado — usando contraseña de desarrollo local. "
            "Definí APP_PASSWORD antes de desplegar en producción."
        )
        APP_PASSWORD = "dev-inseguro-cambiar"
    else:
        raise RuntimeError(
            "APP_PASSWORD no está configurado y la sección Mercados está encendida. "
            "Definí esta variable de entorno en el panel de Render antes de desplegar."
        )
else:
    APP_PASSWORD = _raw_pw

REGISTRATION_OPEN = False  # cambiar a True para reabrir el registro


# ─── Seguridad: headers de respuesta ────────────────────────────────────────
# El CSP se arma por partes en vez de escribirse entero tres veces, porque las
# tres variantes se diferencian en dos directivas y copiarlas completas fue
# justamente lo que dejó permisos de TradingView en páginas que ya no lo cargan.

# Las fuentes se sirven desde Google Fonts en las 17 plantillas (`<link>` a
# fonts.googleapis.com, que a su vez baja los .woff2 de fonts.gstatic.com). El
# CSP anterior no las nombraba en ninguna directiva, así que la hoja de estilos
# caía por style-src y los archivos de fuente por default-src: el sitio entero
# se veía con la fuente de sistema. Van las dos, porque son dos peticiones a dos
# orígenes distintos.
_FONT_STYLE_SRC = "fonts.googleapis.com"
_FONT_SRC = "'self' fonts.gstatic.com"

# TradingView queda reservado a la única ruta que hoy inserta su widget
# (`/compare`) y sólo cuando se habilita el override de QA de Mercados. No se
# agrega globalmente: Inicio, Econometría, Limpiador y Datos no necesitan esos
# permisos ni siquiera durante una auditoría del código heredado.


def _csp(*, nonce: str, wasm: bool = False, tradingview: bool = False) -> str:
    """Arma el CSP de una página a partir de lo que esa página realmente carga.

    `wasm` habilita compilar WebAssembly ('wasm-unsafe-eval', que NO habilita
    eval() de JavaScript como haría 'unsafe-eval'). Pyodide y sus paquetes se
    sirven desde ChartBay, así que ni siquiera el worker Pro abre una CDN.
    """
    wasm_src = " 'wasm-unsafe-eval'" if wasm else ""
    tv_script = " s3.tradingview.com" if tradingview else ""
    tv_frame = (
        "frame-src s3.tradingview.com *.tradingview.com; "
        if tradingview else "frame-src 'none'; "
    )
    return (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}'{wasm_src}{tv_script}; "
        "script-src-attr 'none'; "
        f"style-src 'self' {_FONT_STYLE_SRC}; "
        "style-src-attr 'unsafe-inline'; "
        f"font-src {_FONT_SRC}; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; "
        "worker-src 'self'; "
        f"{tv_frame}"
        "object-src 'none'; "
        "base-uri 'self'; "
        "form-action 'self'; "
        "frame-ancestors 'none'"
    )


# Un Worker corre bajo el CSP de la respuesta de su PROPIO script, no bajo el
# del documento que lo creó. Sin la entrada de /static/js/quantbay.worker.js,
# compilar WebAssembly dentro del worker queda bloqueado aunque /limpiador
# tenga el permiso, y el limpiador cae en silencio al lector clásico.
_CSP_PERFIL_POR_RUTA = {
    "/econometria": {"wasm": True},
    "/agro": {"wasm": True},
    "/limpiador": {"wasm": True},
    "/static/js/quantbay.worker.js": {"wasm": True},
    "/static/js/quantbay.pro.worker.js": {"wasm": True},
}
if SECCIONES["mercados"]:
    _CSP_PERFIL_POR_RUTA["/compare"] = {"tradingview": True}


@app.before_request
def preparar_csp_nonce():
    g.csp_nonce = secrets.token_urlsafe(18)


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    profile = _CSP_PERFIL_POR_RUTA.get(request.path, {})
    response.headers.setdefault("Content-Security-Policy", _csp(nonce=g.csp_nonce, **profile))
    if request.path.startswith("/static/vendor/pyodide/0.26.4/"):
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return response


# ─── Seguridad: CSRF ────────────────────────────────────────────────────────
# Solo corre con la autenticación encendida: sin sesión no hay nada que
# falsificar, y generar el token metería una cookie a cada visitante de un sitio
# que hoy no guarda ni una.
#
# El token se acepta por formulario (`_csrf`) o por cabecera (`X-CSRF-Token`).
# Lo segundo es para las llamadas fetch de Mercados (/api/verdict y
# /api/verdict_one): hoy devuelven 404, pero si se reactiva la sección tienen
# que mandar la cabecera o el POST se rechaza.

_METODOS_INSEGUROS = {"POST", "PUT", "PATCH", "DELETE"}


def csrf_token() -> str:
    """Token de la sesión, creado la primera vez que se pide."""
    token = session.get("_csrf")
    if not token:
        token = secrets.token_urlsafe(32)
        session["_csrf"] = token
    return token


@app.before_request
def verificar_csrf():
    if not AUTH_ENABLED or request.method not in _METODOS_INSEGUROS:
        return None
    esperado = session.get("_csrf", "")
    recibido = request.form.get("_csrf", "") or request.headers.get("X-CSRF-Token", "")
    # compare_digest y no ==: la comparación byte a byte de Python corta en el
    # primer carácter distinto y filtra el prefijo correcto por tiempo.
    if not esperado or not secrets.compare_digest(esperado, recibido):
        if request.path.startswith("/api/"):
            return jsonify({"error": "Token CSRF inválido o ausente"}), 400
        abort(400)
    return None


# ─── Arranque BD ─────────────────────────────────────────────────────────────

def seed_owner():
    conn = db.get_conn()
    row = conn.execute("SELECT id FROM users WHERE username=?", (APP_USERNAME,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)",
            (APP_USERNAME, generate_password_hash(APP_PASSWORD), datetime.now().isoformat()),
        )
        conn.commit()
    conn.close()


def seed_starter_bots():
    conn = db.get_conn()
    owner = conn.execute("SELECT id FROM users WHERE username=?", (APP_USERNAME,)).fetchone()
    if not owner:
        conn.close()
        return
    uid = owner["id"]
    for bot in BOTS_BASE:
        # elimina duplicados conservando el id más bajo
        conn.execute(
            """DELETE FROM bots WHERE user_id=? AND name=? AND id NOT IN (
                   SELECT MIN(id) FROM bots WHERE user_id=? AND name=?)""",
            (uid, bot["name"], uid, bot["name"])
        )
        exists = conn.execute(
            "SELECT 1 FROM bots WHERE name=? AND user_id=?", (bot["name"], uid)
        ).fetchone()
        if not exists:
            conn.execute(
                """INSERT INTO bots(user_id,name,market,timeframe,description,rules,backtest,created_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (uid, bot["name"], bot["market"], bot["timeframe"],
                 bot["description"], bot["rules"], bot.get("backtest", ""),
                 datetime.now().isoformat()),
            )
    conn.commit()
    conn.close()


# La base solo la usan la autenticación y la comunidad de bots, las dos de
# Mercados. Con la sección apagada, abrir SQLite en el import era trabajo puro:
# creaba tablas, hasheaba una contraseña y sembraba bots que ninguna ruta activa
# podía llegar a leer, y encima dejaba un archivo .db (más su -wal y su -shm)
# en el disco efímero de Render en cada arranque.
if AUTH_ENABLED:
    db.init_db()
    seed_owner()
    seed_starter_bots()


@app.context_processor
def inject_globals():
    return {
        "registration_open": REGISTRATION_OPEN,
        "secciones": SECCIONES,
        # La barra superior lo usa para decidir si muestra "Entrar".
        "auth_enabled": AUTH_ENABLED,
        "csp_nonce": g.csp_nonce,
        # Callable y no valor: así el token se crea (y con él la cookie de
        # sesión) solo en las plantillas que de verdad renderizan un formulario.
        "csrf_token": csrf_token,
    }


# ─── Helpers ─────────────────────────────────────────────────────────────────

def sanitize_ticker(raw: str) -> str:
    t = (raw or "").strip().upper()
    if not re.fullmatch(r"[A-Z0-9.\^\-=]{1,15}", t):
        return ""
    return t


def to_tradingview(ticker: str) -> str:
    tv = getattr(config, "TRADINGVIEW", {})
    if ticker in tv:
        return tv[ticker]
    if ticker.endswith("-USD"):
        return ticker.replace("-USD", "USD")
    if ticker.startswith("^"):
        return ticker[1:]
    return ticker


def _safe_name(ticker: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", ticker.upper())


def _safe_redirect(url: str) -> str:
    """Devuelve url solo si es una ruta relativa que empieza con /. Previene open redirect."""
    parsed = urlparse(url or "")
    if url and url.startswith("/") and not parsed.netloc and not parsed.scheme:
        return url
    return "/"


# interval -> (yf_interval, yf_period, tv_interval)
ALLOWED_INTERVALS = {
    "1d":  ("1d",  "1y",  "D"),
    "1wk": ("1wk", "5y",  "W"),
    "1h":  ("1h",  "60d", "60"),
}


# El contador es un leer-sumar-escribir: sin candado, dos hilos leen el mismo
# valor y la segunda visita pisa a la primera en vez de sumarse (medido: 30
# cargas en paralelo contaban 15). Vale por proceso, que alcanza con el worker
# único de Render free; con más de un worker habría que mover esto a sqlite.
_visits_lock = threading.Lock()


def bump_visits() -> int:
    fp = CACHE_DIR / "visits.txt"
    with _visits_lock:
        try:
            n = int(fp.read_text().strip())
        except Exception:
            n = 0
        n += 1
        try:
            write_atomic(fp, str(n))
        except Exception:
            pass
        return n


# ─── Auth ────────────────────────────────────────────────────────────────────

# Rate limiting de login: max 5 intentos por IP en 60 segundos.
# Funciona por proceso (suficiente para gunicorn con 1 worker en Render free).
_LOGIN_WINDOW = 60
_LOGIN_MAX = 5
_login_attempts: dict = defaultdict(list)


def _check_login_rate(ip: str) -> bool:
    """Retorna True si el IP puede intentar login; False si superó el límite."""
    now = time.time()
    attempts = _login_attempts[ip]
    attempts[:] = [t for t in attempts if now - t < _LOGIN_WINDOW]
    if len(attempts) >= _LOGIN_MAX:
        return False
    attempts.append(now)
    return True


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("user"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Sesión requerida", "login": True}), 401
            return redirect(url_for("login", next=request.path))
        return f(*args, **kwargs)
    return wrapper


@app.route("/login", methods=["GET", "POST"])
@solo_con_auth
def login():
    error = None
    if request.method == "POST":
        ip = request.remote_addr or "unknown"
        if not _check_login_rate(ip):
            error = "Demasiados intentos. Esperá un minuto antes de volver a intentar."
        else:
            u = request.form.get("username", "").strip()
            p = request.form.get("password", "")
            conn = db.get_conn()
            row = conn.execute("SELECT * FROM users WHERE username=?", (u,)).fetchone()
            conn.close()
            if row and check_password_hash(row["password_hash"], p):
                session["user"] = row["username"]
                session["uid"] = row["id"]
                return redirect(_safe_redirect(request.args.get("next", "")))
            error = "Usuario o contraseña incorrectos."
    return render_template("login.html", error=error)


@app.route("/register", methods=["GET", "POST"])
@solo_con_auth
def register():
    if not REGISTRATION_OPEN:
        return render_template("register.html", error=None)
    error = None
    if request.method == "POST":
        u = request.form.get("username", "").strip()
        p = request.form.get("password", "")
        if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", u):
            error = "Usuario: 3-20 caracteres (letras, números o _)."
        elif len(p) < 6:
            error = "La contraseña debe tener al menos 6 caracteres."
        else:
            conn = db.get_conn()
            try:
                conn.execute(
                    "INSERT INTO users(username, password_hash, created_at) VALUES(?,?,?)",
                    (u, generate_password_hash(p), datetime.now().isoformat()),
                )
                conn.commit()
                row = conn.execute("SELECT * FROM users WHERE username=?", (u,)).fetchone()
                session["user"] = row["username"]
                session["uid"] = row["id"]
                conn.close()
                return redirect(url_for("community"))
            except sqlite3.IntegrityError:
                error = "Ese nombre de capitán ya está tomado."
                conn.close()
    return render_template("register.html", error=error)


# POST y no GET: con logout por GET alcanza que un tercero incruste
# <img src="/logout"> en cualquier página para desloguear al usuario, y un
# prefetch del navegador puede cerrar la sesión sin que nadie haga clic.
# El formulario de la barra superior manda el token CSRF, que ya valida
# `verificar_csrf`.
@app.route("/logout", methods=["POST"])
@solo_con_auth
def logout():
    session.clear()
    return redirect(url_for("login"))


# ─── Versión desplegada ──────────────────────────────────────────────────────
# Sirve para confirmar desde afuera QUÉ código está corriendo. Sin esto, un
# cambio que no altera ninguna respuesta (un arreglo de concurrencia, por caso)
# es indistinguible de un deploy que nunca ocurrió.

_STARTED = time.time()


def _git_commit() -> str:
    """SHA del commit desplegado.

    Render inyecta RENDER_GIT_COMMIT en el entorno. En local no existe, así que
    lo leemos del repo para que /version también sirva mientras se desarrolla.
    """
    sha = os.environ.get("RENDER_GIT_COMMIT", "")
    if sha:
        return sha
    try:
        head = (ROOT / ".git" / "HEAD").read_text(encoding="utf-8").strip()
        if head.startswith("ref: "):
            head = (ROOT / ".git" / head[5:]).read_text(encoding="utf-8").strip()
        return head
    except Exception:
        return "desconocido"


@app.route("/version")
def version():
    sha = _git_commit()
    arranque = datetime.fromtimestamp(_STARTED)
    return jsonify({
        "commit": sha,
        "commit_short": sha[:7] if sha != "desconocido" else sha,
        "branch": os.environ.get("RENDER_GIT_BRANCH", ""),
        # el uptime delata el redeploy: tras uno nuevo, vuelve a empezar de cero
        "arrancado": arranque.isoformat(timespec="seconds"),
        "uptime_s": round(time.time() - _STARTED),
    })


@app.route("/source.tar.gz")
def source_archive():
    """Offer the complete source of the version served over the network."""
    return send_file(
        io.BytesIO(build_source_archive(ROOT)),
        mimetype="application/gzip",
        as_attachment=True,
        download_name="chartbay-source.tar.gz",
        max_age=3600,
    )


# ─── Herramienta ─────────────────────────────────────────────────────────────

@app.route("/")
def dashboard():
    return render_template(
        "home.html",
        tickers=config.TICKERS,
        tradingview=getattr(config, "TRADINGVIEW", {}),
        nombres=getattr(config, "NOMBRES", {}),
        perfil=config.PERFIL_RIESGO,
        hoy=date.today().isoformat(),
        visits=bump_visits(),
    )


@app.route("/chartbay")
@seccion("mercados")
def chartbay():
    return render_template("chartbay.html")


@app.route("/finanzas")
@seccion("mercados")
def finanzas():
    return render_template("finanzas.html")


@app.route("/reports")
@seccion("mercados")
def reports():
    files = []
    if REPORTS_DIR.exists():
        files = sorted([p.name for p in REPORTS_DIR.glob("*.md")], reverse=True)
    return render_template("reports.html", files=files)


@app.route("/reportes")
@seccion("mercados")
def reportes_alias():
    return redirect(url_for("reports"))


@app.route("/reports/<path:name>")
@seccion("mercados")
def report_view(name):
    if not name.endswith(".md") or "/" in name or "\\" in name:
        abort(404)
    fp = REPORTS_DIR / name
    if not fp.exists():
        abort(404)
    return render_template("report.html", name=name, content=fp.read_text(encoding="utf-8"))


# ─── Comunidad ───────────────────────────────────────────────────────────────

@app.route("/community")
@seccion("mercados")
def community():
    q = request.args.get("q", "").strip()
    market = request.args.get("market", "").strip()
    timeframe = request.args.get("timeframe", "").strip()
    sort = request.args.get("sort", "recientes")
    filtering = bool(q or market or timeframe or request.args.get("sort"))

    conn = db.get_conn()
    markets = [r[0] for r in conn.execute(
        "SELECT DISTINCT market FROM bots WHERE market IS NOT NULL AND market<>'' ORDER BY market")]
    timeframes = [r[0] for r in conn.execute(
        "SELECT DISTINCT timeframe FROM bots WHERE timeframe IS NOT NULL AND timeframe<>'' ORDER BY timeframe")]

    sel = ("SELECT b.*, u.username AS author, "
           "(SELECT ROUND(AVG(stars),1) FROM reviews r WHERE r.bot_id=b.id) AS avg_stars, "
           "(SELECT COUNT(*) FROM reviews r WHERE r.bot_id=b.id) AS n_reviews "
           "FROM bots b JOIN users u ON u.id=b.user_id WHERE 1=1 ")
    params = []
    if q:
        sel += " AND (b.name LIKE ? OR b.description LIKE ? OR b.rules LIKE ?)"
        like = f"%{q}%"; params += [like, like, like]
    if market:
        sel += " AND b.market=?"; params.append(market)
    if timeframe:
        sel += " AND b.timeframe=?"; params.append(timeframe)
    order = (" ORDER BY COALESCE(avg_stars,0) DESC, n_reviews DESC, b.id DESC"
             if sort == "estrellas" else " ORDER BY b.id DESC")

    results, featured, recent = [], [], []
    if filtering:
        results = conn.execute(sel + order, params).fetchall()
    else:
        featured = conn.execute(
            sel + " AND (SELECT COUNT(*) FROM reviews r WHERE r.bot_id=b.id)>0"
                  " ORDER BY COALESCE(avg_stars,0) DESC, n_reviews DESC, b.id DESC LIMIT 6", params).fetchall()
        recent = conn.execute(sel + " ORDER BY b.id DESC LIMIT 6", params).fetchall()
    conn.close()
    return render_template("community.html", filtering=filtering, results=results,
                           featured=featured, recent=recent, markets=markets, timeframes=timeframes,
                           q=q, market=market, timeframe=timeframe, sort=sort)


@app.route("/community/new", methods=["GET", "POST"])
@seccion("mercados")
@login_required
def bot_new():
    error = None
    if request.method == "POST":
        f = request.form
        name = f.get("name", "").strip()
        if not name:
            error = "Ponle un nombre al bot."
        else:
            conn = db.get_conn()
            conn.execute(
                """INSERT INTO bots(user_id,name,market,timeframe,description,rules,backtest,created_at)
                   VALUES(?,?,?,?,?,?,?,?)""",
                (session["uid"], name[:80], f.get("market", "")[:60], f.get("timeframe", "")[:40],
                 f.get("description", "")[:2000], f.get("rules", "")[:2000], f.get("backtest", "")[:1000],
                 datetime.now().isoformat()),
            )
            conn.commit()
            bid = conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]
            conn.close()
            return redirect(url_for("bot_detail", bot_id=bid))
    return render_template("bot_new.html", error=error)


@app.route("/community/bot/<int:bot_id>")
@seccion("mercados")
def bot_detail(bot_id):
    conn = db.get_conn()
    bot = conn.execute(
        "SELECT b.*, u.username AS author FROM bots b JOIN users u ON u.id=b.user_id WHERE b.id=?",
        (bot_id,),
    ).fetchone()
    if not bot:
        conn.close()
        abort(404)
    reviews = conn.execute(
        "SELECT r.*, u.username AS author FROM reviews r JOIN users u ON u.id=r.user_id "
        "WHERE r.bot_id=? ORDER BY r.id DESC", (bot_id,),
    ).fetchall()
    agg = conn.execute(
        "SELECT ROUND(AVG(stars),1) AS avg, COUNT(*) AS n FROM reviews WHERE bot_id=?", (bot_id,),
    ).fetchone()
    conn.close()
    return render_template("bot_detail.html", bot=bot, reviews=reviews,
                           avg=agg["avg"], n=agg["n"])


@app.route("/community/bot/<int:bot_id>/review", methods=["POST"])
@seccion("mercados")
@login_required
def bot_review(bot_id):
    try:
        stars = int(request.form.get("stars", "0"))
    except ValueError:
        stars = 0
    stars = max(1, min(5, stars))
    comment = request.form.get("comment", "")[:1000]
    conn = db.get_conn()
    if conn.execute("SELECT 1 FROM bots WHERE id=?", (bot_id,)).fetchone():
        conn.execute(
            "INSERT INTO reviews(bot_id,user_id,stars,comment,created_at) VALUES(?,?,?,?,?)",
            (bot_id, session["uid"], stars, comment, datetime.now().isoformat()),
        )
        conn.commit()
    conn.close()
    return redirect(url_for("bot_detail", bot_id=bot_id))


# ─── API análisis ────────────────────────────────────────────────────────────

@app.route("/api/snapshot")
@seccion("mercados")
def api_snapshot():
    t = request.args.get("ticker", "").strip()
    if t not in config.TICKERS:
        return jsonify({"ok": False, "error": "ticker no permitido"}), 400
    return _snapshot_response(t)


@app.route("/api/lookup")
@seccion("mercados")
def api_lookup():
    t = sanitize_ticker(request.args.get("ticker", ""))
    if not t:
        return jsonify({"ok": False, "error": "símbolo inválido"}), 400
    iv_key = request.args.get("interval", "1d")
    if iv_key not in ALLOWED_INTERVALS:
        iv_key = "1d"
    interval, period, tv_interval = ALLOWED_INTERVALS[iv_key]
    return _snapshot_response(t, interval, period, tv_interval)


def _snapshot_response(t: str, interval: str = "1d", period: str = "1y", tv_interval: str = "D"):
    try:
        df = data.descargar(t, interval, period)
        snap = indicators.construir_snapshot(df)
        nombre = getattr(config, "NOMBRES", {}).get(t, t)
        return jsonify({"ok": True, "ticker": t, "nombre": nombre,
                        "tv": to_tradingview(t), "tv_interval": tv_interval, "snapshot": snap})
    except Exception as e:
        return jsonify({"ok": False, "ticker": t, "error": str(e)})


@app.route("/api/news")
@seccion("mercados")
def api_news():
    t = sanitize_ticker(request.args.get("ticker", ""))
    if not t:
        return jsonify({"ok": False, "error": "símbolo inválido"}), 400
    try:
        import yfinance as yf
        raw = yf.Ticker(t).news or []
        articles = []
        for item in raw[:5]:
            ct = item.get("content", {})
            if ct:
                title = ct.get("title", "")
                publisher = ct.get("provider", {}).get("displayName", "")
                url = ct.get("canonicalUrl", {}).get("url", "")
                pub_date = ct.get("pubDate", "")
            else:
                title = item.get("title", "")
                publisher = item.get("publisher", "")
                url = item.get("link", "")
                pub_date = item.get("providerPublishTime", "")
            if title and url:
                articles.append({"title": title, "publisher": publisher,
                                  "url": url, "date": pub_date})
        return jsonify({"ok": True, "ticker": t, "news": articles})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})


@app.route("/api/verdict_one", methods=["POST"])
@seccion("mercados")
@login_required
def api_verdict_one():
    t = sanitize_ticker(request.args.get("ticker", ""))
    if not t:
        return jsonify({"error": "símbolo inválido"}), 400
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return jsonify({"error": "Falta ANTHROPIC_API_KEY en el .env"}), 400

    today = date.today().isoformat()
    cache_fp = CACHE_DIR / f"one_{_safe_name(t)}_{today}.json"
    if cache_fp.exists():
        return jsonify(json.loads(cache_fp.read_text(encoding="utf-8")))

    import analyze
    try:
        df = data.descargar(t, config.INTERVAL, config.PERIOD)
        snap = indicators.construir_snapshot(df)
        texto = analyze.analizar(t, snap, config.PERFIL_RIESGO, config.AI_MODEL)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    payload = {"ticker": t, "generado": datetime.now().isoformat(timespec="seconds"),
               "veredicto": texto}
    write_atomic(cache_fp, json.dumps(payload, ensure_ascii=False, indent=2))
    return jsonify(payload)


@app.route("/api/verdict", methods=["POST"])
@seccion("mercados")
@login_required
def api_verdict():
    today = date.today().isoformat()
    cache_fp = CACHE_DIR / f"verdict_{today}.json"
    if cache_fp.exists():
        return jsonify(json.loads(cache_fp.read_text(encoding="utf-8")))
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return jsonify({"error": "Falta ANTHROPIC_API_KEY en el .env"}), 400

    import analyze
    result = {}
    for t in config.TICKERS:
        try:
            df = data.descargar(t, config.INTERVAL, config.PERIOD)
            snap = indicators.construir_snapshot(df)
            result[t] = analyze.analizar(t, snap, config.PERFIL_RIESGO, config.AI_MODEL)
        except Exception as e:
            result[t] = f"**Error:** {e}"

    payload = {"fecha": today, "generado": datetime.now().isoformat(timespec="seconds"),
               "veredictos": result}
    write_atomic(cache_fp, json.dumps(payload, ensure_ascii=False, indent=2))
    return jsonify(payload)


@app.route("/api/verdict", methods=["GET"])
@seccion("mercados")
def api_verdict_get():
    today = date.today().isoformat()
    cache_fp = CACHE_DIR / f"verdict_{today}.json"
    if cache_fp.exists():
        return jsonify(json.loads(cache_fp.read_text(encoding="utf-8")))
    return jsonify({"veredictos": {}, "fecha": today})


@app.route("/compare")
@seccion("mercados")
def compare_view():
    a = sanitize_ticker(request.args.get("a", ""))
    b = sanitize_ticker(request.args.get("b", ""))
    return render_template("compare.html", a=a, b=b)


@app.route("/comparar")
@seccion("mercados")
def comparar_alias():
    return redirect(url_for("compare_view"))


@app.route("/heatmap")
@seccion("mercados")
def heatmap():
    return render_template("heatmap.html",
                           tickers=config.TICKERS,
                           nombres=getattr(config, "NOMBRES", {}))


@app.route("/guia")
def guia():
    return render_template("guia.html")


@app.route("/limpiador")
def limpiador():
    """Data Cleaner local para CSV/XLSX; conserva acceso al motor estadístico."""
    template = (
        "limpiador-clasico.html"
        if request.args.get("motor") == "estadistico"
        else "limpiador.html"
    )
    return render_template(template)


@app.route("/econometria")
def econometria():
    return render_template("quantbay.html", quantbay_module="econometria")


@app.route("/agro")
@seccion("agro")
def agro():
    return render_template("quantbay.html", quantbay_module="agro")


@app.route("/quantbay")
def quantbay():
    return redirect(url_for("econometria"))


@app.route("/datasets/<path:name>")
def quantbay_dataset(name):
    allowed = {
        "01_simple_linear.csv",
        "02_beta1_eq_beta2_approx_valid.csv",
        "03_beta1_eq_beta2_false.csv",
        "04_beta1_plus_beta2_eq_1.csv",
        "05_perfect_collinearity.csv",
    }
    if name not in allowed:
        abort(404)
    fp = ROOT / "datasets" / name
    if not fp.exists():
        abort(404)
    return Response(fp.read_text(encoding="utf-8"), mimetype="text/csv")


# ─── Datos Frecuentes ────────────────────────────────────────────────────────
# Series macro oficiales (FRED y, a futuro, BCRA/World Bank/IMF/OECD) listas
# para descargar. La lógica de fuentes vive en el paquete `providers`; acá
# sólo hay rutas HTTP + una caché diaria en disco para no golpear las APIs.

DATA_CACHE_DIR = CACHE_DIR / "data"
DATA_CACHE_DIR.mkdir(exist_ok=True)
_INDICATOR_RE = re.compile(r"^[a-z0-9_]{1,40}$")


def _valid_indicator(indicator_id: str):
    """Devuelve el Indicator si el id es válido y está en el catálogo; si no, None."""
    if not _INDICATOR_RE.fullmatch(indicator_id or ""):
        return None
    return providers.get_indicator(indicator_id)


def _series_cached(indicator_id: str):
    """Series del indicador, con caché diaria en disco (las macro cambian, a lo sumo, a diario)."""
    fp = DATA_CACHE_DIR / f"{indicator_id}_{date.today().isoformat()}.json"
    if fp.exists():
        try:
            return providers.series_from_json(json.loads(fp.read_text(encoding="utf-8")))
        except Exception:
            pass  # caché corrupta: se vuelve a pedir
    series = providers.fetch_series(indicator_id)
    try:
        write_atomic(fp, providers.to_json_str(series))
    except Exception:
        pass
    return series


def _fred_ready() -> bool:
    return any(s["code"] == "fred" and s["available"] for s in providers.provider_status())


@app.route("/data")
@seccion("datos")
def frequent_data():
    available_providers = {
        source["code"] for source in providers.provider_status() if source["available"]
    }
    bootstrap = {
        "catalog": providers.catalog_public(),
        "categories": providers.CATEGORIES,
        "fredReady": _fred_ready(),
        "downloadableIds": [
            indicator.id
            for indicator in providers.CATALOG
            if indicator.provider in available_providers
        ],
    }
    return render_template(
        "frequent_data.html",
        bootstrap=bootstrap,
        sources=providers.provider_status(),
        fred_ready=bootstrap["fredReady"],
        hoy=date.today().isoformat(),
    )


@app.route("/api/data/catalog")
@seccion("datos")
def api_data_catalog():
    return jsonify({
        "ok": True,
        "categories": providers.CATEGORIES,
        "catalog": providers.catalog_public(),
        "sources": providers.provider_status(),
    })


@app.route("/api/data/series/<indicator_id>")
@seccion("datos")
def api_data_series(indicator_id):
    if not _valid_indicator(indicator_id):
        return jsonify({"ok": False, "error": "Indicador desconocido"}), 404
    try:
        return jsonify({"ok": True, **providers.to_json(_series_cached(indicator_id))})
    except providers.ProviderError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/data/meta/<indicator_id>")
@seccion("datos")
def api_data_meta(indicator_id):
    ind = _valid_indicator(indicator_id)
    if not ind:
        return jsonify({"ok": False, "error": "Indicador desconocido"}), 404
    fp = DATA_CACHE_DIR / f"meta_{indicator_id}_{date.today().isoformat()}.json"
    if fp.exists():
        try:
            return jsonify(json.loads(fp.read_text(encoding="utf-8")))
        except Exception:
            pass
    try:
        obs = providers.latest_observation(indicator_id)
        payload = {
            "ok": True, "id": indicator_id, "frequency": ind.frequency,
            "last_updated": obs.date if obs else None,
            "value": obs.value if obs else None,
        }
        try:
            write_atomic(fp, json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass
        return jsonify(payload)
    except providers.ProviderError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502


@app.route("/api/data/download/<indicator_id>")
@seccion("datos")
def api_data_download(indicator_id):
    if not _valid_indicator(indicator_id):
        abort(404)
    fmt = (request.args.get("format", "csv") or "csv").lower()
    spec = providers.EXPORT_FORMATS.get(fmt)
    if not spec:
        return jsonify({"ok": False, "error": f"Formato no soportado: {fmt}"}), 400
    try:
        series = _series_cached(indicator_id)
    except providers.ProviderError as e:
        return jsonify({"ok": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 502
    body = spec["render"](series)
    filename = f"chartbay_{indicator_id}.{spec['ext']}"
    return Response(
        body, mimetype=spec["mimetype"],
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


if __name__ == "__main__":
    # debug=True is safe here: this block only runs with `python web/app.py`.
    # Gunicorn (producción) ignora este bloque completamente.
    #
    # PORT igual que en el Procfile: en macOS el 5000 lo ocupa ControlCenter
    # (receptor de AirPlay), así que fijarlo dejaba el bloque inarrancable.
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=True)
