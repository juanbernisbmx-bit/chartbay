"""
ChartBay — app Flask del laboratorio de econometría.

El cálculo corre en el navegador (motor TypeScript, limpiador WebAssembly y
Pyodide para Pro). Acá viven las rutas, las plantillas, las cabeceras de
seguridad y la sección Datos, que consulta FRED y World Bank a través del
paquete `providers`.

Arrancar en local:
    pip install -r requirements.txt
    python web/app.py
    -> abre http://127.0.0.1:5000
"""
import io
import json
import os
import re
import secrets
import sys
import tempfile
import time
from datetime import date, datetime
from functools import wraps
from pathlib import Path

from dotenv import load_dotenv
from flask import (
    Flask, Response, abort, g, jsonify, redirect, render_template, request, send_file,
    url_for,
)

ROOT = Path(__file__).resolve().parent.parent
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))  # permite 'import providers'
sys.path.insert(0, str(HERE))  # permite 'import source_archive' bajo gunicorn (web/ en el path)
load_dotenv(ROOT / ".env")

import providers        # noqa: E402
from chartpython_manual import notebook_de_practica  # noqa: E402
from rate_limit import Limitador, Regla, ip_del_cliente  # noqa: E402
from source_archive import build_source_archive  # noqa: E402

CACHE_DIR = HERE / "cache"
CACHE_DIR.mkdir(exist_ok=True)


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
# Apagar una sección acá la desenchufa sin borrar nada: sus rutas pasan a
# devolver 404 y sus enlaces desaparecen del menú, pero las vistas, las
# plantillas y los tests siguen en el repo.
SECCIONES = {
    # Escondida por ahora: sin pestaña ni enlaces y con sus rutas en 404. El
    # código, la plantilla y los tests siguen (los tests la encienden).
    "datos": False,
    # ChartPython sale en beta: se puede apagar sin tocar nada más si su
    # intérprete da problemas en algún navegador.
    "chartpython": True,
}


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


# ─── Seguridad: headers de respuesta ────────────────────────────────────────
# El CSP se arma por partes en vez de escribirse entero en cada variante,
# porque las variantes se diferencian en una directiva y copiarlas completas fue
# justamente lo que dejó permisos de más en páginas que no los usaban.

# Las fuentes se sirven desde Google Fonts en todas las plantillas (`<link>` a
# fonts.googleapis.com, que a su vez baja los .woff2 de fonts.gstatic.com). El
# CSP anterior no las nombraba en ninguna directiva, así que la hoja de estilos
# caía por style-src y los archivos de fuente por default-src: el sitio entero
# se veía con la fuente de sistema. Van las dos, porque son dos peticiones a dos
# orígenes distintos.
_FONT_STYLE_SRC = "fonts.googleapis.com"
_FONT_SRC = "'self' fonts.gstatic.com"


def _csp(*, nonce: str, wasm: bool = False) -> str:
    """Arma el CSP de una página a partir de lo que esa página realmente carga.

    `wasm` habilita compilar WebAssembly ('wasm-unsafe-eval', que NO habilita
    eval() de JavaScript como haría 'unsafe-eval'). Pyodide y sus paquetes se
    sirven desde ChartBay, así que ni siquiera el worker Pro abre una CDN.
    """
    wasm_src = " 'wasm-unsafe-eval'" if wasm else ""
    return (
        "default-src 'self'; "
        f"script-src 'self' 'nonce-{nonce}'{wasm_src}; "
        "script-src-attr 'none'; "
        f"style-src 'self' {_FONT_STYLE_SRC}; "
        "style-src-attr 'unsafe-inline'; "
        f"font-src {_FONT_SRC}; "
        "img-src 'self' data: blob:; "
        "connect-src 'self'; "
        "worker-src 'self'; "
        "frame-src 'none'; "
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
    "/limpiador": {"wasm": True},
    "/chartpython": {"wasm": True},
    "/static/js/quantbay.worker.js": {"wasm": True},
    "/static/js/quantbay.pro.worker.js": {"wasm": True},
    "/static/js/chartpython.worker.js": {"wasm": True},
}


@app.before_request
def preparar_csp_nonce():
    g.csp_nonce = secrets.token_urlsafe(18)


# ─── Límite de solicitudes por IP ────────────────────────────────────────────
# Los números salen de lo que pide una visita real. Abrir el laboratorio y
# elegir Pro baja unos veinte archivos de /static (bundle, hojas, Pyodide y sus
# paquetes), así que los estáticos tienen un techo propio y amplio. Una clase
# entera detrás del NAT de la facultad comparte IP: 120 páginas por minuto le
# dan al grupo dos por segundo sostenidas.
#
# Se registra después de preparar_csp_nonce porque el 429 también pasa por
# add_security_headers, que necesita el nonce.
_REGLAS_DE_LIMITE = (
    Regla("general", limite=120, ventana_s=60),
    Regla("estaticos", limite=600, ventana_s=60, rutas=("/static/",)),
    # Cada descarga es el repositorio entero.
    Regla("fuente", limite=10, ventana_s=60, rutas=("/source.tar.gz",)),
    # Con Datos encendida, cada serie fuera de caché es una llamada a FRED o a
    # World Bank hecha con nuestra IP y nuestra clave.
    Regla("datos", limite=30, ventana_s=60, rutas=("/data", "/api/data/")),
)
LIMITADOR = Limitador(_REGLAS_DE_LIMITE)
# Render define RENDER=true en el entorno de sus servicios.
_DETRAS_DE_RENDER = os.environ.get("RENDER", "").lower() == "true"


@app.before_request
def limitar_por_ip():
    ip = ip_del_cliente(request.headers, request.remote_addr, detras_de_render=_DETRAS_DE_RENDER)
    espera = LIMITADOR.registrar(request.path, ip)
    if espera is None:
        return None
    mensaje = "Demasiadas solicitudes. Probá de nuevo en unos segundos."
    if request.path.startswith("/api/"):
        respuesta = jsonify({"ok": False, "error": mensaje})
    else:
        respuesta = Response(mensaje + "\n", mimetype="text/plain")
    respuesta.status_code = 429
    respuesta.headers["Retry-After"] = str(espera)
    return respuesta


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


@app.context_processor
def inject_globals():
    return {
        "secciones": SECCIONES,
        "csp_nonce": g.csp_nonce,
    }


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
    return render_template("home.html")


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


@app.route("/chartpython")
@seccion("chartpython")
def chartpython():
    """Notebook de Python en el navegador: el intérprete es Pyodide, no el servidor."""
    return render_template("chartpython.html")


@app.route("/chartpython/manual")
@seccion("chartpython")
def chartpython_manual():
    """Manual de uso: el notebook y los comandos de pandas para limpiar y analizar datos."""
    return render_template("chartpython_manual.html")


@app.route("/chartpython/manual.ipynb")
@seccion("chartpython")
def chartpython_manual_notebook():
    """Los ejemplos del manual como notebook, para abrirlos con "Abrir .ipynb"."""
    # Render termina el TLS antes de Flask: sin forzar el esquema, el enlace
    # que queda escrito en el notebook saldría con http.
    url_manual = url_for("chartpython_manual", _external=True, _scheme="https" if _DETRAS_DE_RENDER else None)
    contenido = notebook_de_practica(url_manual=url_manual)
    return Response(
        contenido,
        mimetype="application/x-ipynb+json",
        headers={"Content-Disposition": 'attachment; filename="Manual de ChartPython.ipynb"'},
    )


@app.route("/econometria")
def econometria():
    return render_template("quantbay.html")


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
