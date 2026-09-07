"""
Tests de la app Flask: rutas activas, rutas apagadas, headers, CSP y sesión.

Se puede correr de dos formas, igual que tests/test_providers.py:
    python tests/test_web.py         # runner propio, sin dependencias
    pytest tests/test_web.py         # si tenés pytest instalado

Necesita Flask (está en requirements.txt) pero NO necesita scipy ni
statsmodels: acá no se calcula nada, solo se verifican respuestas HTTP.

Cómo se prueban las dos configuraciones
---------------------------------------
Casi todo lo que decide el arranque —si hay login, si se abre SQLite, qué
permisos lleva el CSP— se resuelve en el import de `web.app` a partir de
SECCIONES. Probar solo la configuración que está fija hoy dejaría sin cubrir
el override de auditoría de Mercados. Ese override permite revisar las rutas
heredadas, pero no declara que la sección esté soportada ni lista para desplegar.

Por eso los tests reimportan el módulo con `CHARTBAY_SECCIONES` distinto
(`_cargar_app`), apuntando antes la base a un archivo temporal para que la
variante con sesión no escriba en `web/chartbay.db`.
"""
import importlib
import io
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))

_TMP = Path(tempfile.mkdtemp(prefix="chartbay-tests-"))


def _forzar_hash_disponible() -> None:
    """Usa pbkdf2 si el intérprete no trae scrypt.

    Werkzeug hashea con scrypt por defecto, y scrypt necesita OpenSSL 1.1.1+.
    El Python del sistema en macOS viene compilado contra LibreSSL 2.8.3, donde
    `hashlib.scrypt` directamente no existe: sin esto, los tests de la variante
    con sesión fallan al sembrar el usuario y el error ("module 'hashlib' has no
    attribute 'scrypt'") no dice nada del código que se está probando.

    El algoritmo da lo mismo acá: estos tests verifican CSRF, ruteo y cierre de
    sesión, no la fortaleza del hash. En producción (Render, Python 3.12) scrypt
    existe y esta función no hace nada.
    """
    import hashlib
    if hasattr(hashlib, "scrypt"):
        return
    import werkzeug.security as ws
    if getattr(ws.generate_password_hash, "_chartbay_pbkdf2", False):
        return
    original = ws.generate_password_hash

    def con_pbkdf2(password, method="pbkdf2", salt_length=16):
        return original(password, method="pbkdf2", salt_length=salt_length)

    con_pbkdf2._chartbay_pbkdf2 = True
    ws.generate_password_hash = con_pbkdf2


def _cargar_app(**overrides):
    """Reimporta web.app con las variables de entorno pedidas.

    Devuelve el módulo ya recargado. Las claves con valor None se borran del
    entorno, que es como se prueba "esta variable no está definida".
    """
    previo = {}
    entorno = {
        "SECRET_KEY": "clave-de-test",
        "APP_ENV": "development",
        "CHARTBAY_SECCIONES": "",
        **overrides,
    }
    for k, v in entorno.items():
        previo[k] = os.environ.get(k)
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        _forzar_hash_disponible()
        import db
        # Antes del import de web.app: si la configuración enciende la sesión,
        # el módulo siembra el usuario y los bots al importarse.
        db.DB_PATH = _TMP / "test.db"

        import web.app as app_module
        return importlib.reload(app_module)
    finally:
        for k, v in previo.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _cliente(**overrides):
    modulo = _cargar_app(**overrides)
    return modulo, modulo.app.test_client()


# Las dos configuraciones que importan. La primera es la de ChartBay 1.0.
SIN_SESION = {}
CON_SESION = {"CHARTBAY_SECCIONES": "mercados=on", "APP_PASSWORD": "clave-de-test"}


# ── rutas activas ────────────────────────────────────────────────────────────

def test_rutas_activas_responden_200():
    _, c = _cliente(**SIN_SESION)
    for ruta in (
        "/", "/version", "/guia", "/econometria", "/limpiador", "/data",
        "/api/data/catalog",
    ):
        assert c.get(ruta).status_code == 200, f"{ruta} no devolvió 200"


def test_paginas_activas_ofrecen_el_codigo_fuente():
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/", "/guia", "/econometria", "/limpiador", "/data"):
        html = c.get(ruta).get_data(as_text=True)
        assert 'href="/source.tar.gz"' in html, ruta
        assert 'rel="source"' in html and "Código fuente" in html, ruta


def test_archivo_de_fuente_incluye_licencia_y_excluye_estado_local():
    _, c = _cliente(**SIN_SESION)
    respuesta = c.get("/source.tar.gz")
    assert respuesta.status_code == 200
    assert respuesta.mimetype == "application/gzip"
    assert "attachment" in respuesta.headers["Content-Disposition"]
    with tarfile.open(fileobj=io.BytesIO(respuesta.data), mode="r:gz") as archive:
        names = set(archive.getnames())
    for requerido in (
        "LICENSE",
        "README.md",
        "TRADEMARKS.md",
        "quantbay/src/pro.worker.entry.ts",
        "quantbay/src/pro/pyodide/proWorkerClient.ts",
        "web/static/js/quantbay.pro.worker.js",
    ):
        assert f"chartbay-source/{requerido}" in names
    assert not any("/.git/" in name or name.endswith("/.env") for name in names)


def test_archivo_de_fuente_documenta_pyodide_sin_duplicar_binarios_upstream():
    from source_archive import _safe_source_file

    base = Path("web/static/vendor/pyodide/0.26.4")
    for documentacion in (
        "LICENSE.PYODIDE",
        "LICENSE.OPENBLAS",
        "chartbay-pyodide-manifest.json",
        "pyodide-lock.json",
    ):
        assert _safe_source_file(ROOT, base / documentacion)
    for binario in (
        "pyodide.asm.wasm",
        "pyodide.js",
        "statsmodels-0.14.2-cp312-cp312-pyodide_2024_0_wasm32.whl",
    ):
        assert not _safe_source_file(ROOT, base / binario)
    assert _safe_source_file(ROOT, Path("scripts/vendor_pyodide.py"))


def test_quantbay_redirige_a_econometria():
    _, c = _cliente(**SIN_SESION)
    r = c.get("/quantbay")
    assert r.status_code == 302
    assert r.headers["Location"].endswith("/econometria")


def test_datasets_solo_sirve_los_casos_del_catalogo():
    _, c = _cliente(**SIN_SESION)
    assert c.get("/datasets/01_simple_linear.csv").status_code == 200
    # No está en la lista blanca: no existe como caso de práctica.
    assert c.get("/datasets/otro.csv").status_code == 404
    # Traversal: la lista blanca lo corta antes de tocar el filesystem.
    assert c.get("/datasets/../config.py").status_code in (301, 308, 404)


# ── rutas apagadas ───────────────────────────────────────────────────────────

def test_secciones_apagadas_devuelven_404():
    _, c = _cliente(**SIN_SESION)
    apagadas = ("/agro", "/chartbay", "/finanzas", "/community", "/heatmap",
                "/compare", "/reports", "/api/snapshot", "/api/lookup", "/api/news")
    for ruta in apagadas:
        assert c.get(ruta).status_code == 404, f"{ruta} debía estar apagada"


def test_secciones_apagadas_no_aparecen_en_el_menu():
    _, c = _cliente(**SIN_SESION)
    html = c.get("/").get_data(as_text=True)
    assert "Econometría" in html and "Limpiador" in html and "Datos" in html
    assert 'href="/agro"' not in html
    assert 'href="/finanzas"' not in html
    assert 'href="/community"' not in html


def test_override_de_mercados_expone_rutas_para_auditoria():
    """El override deja auditar rutas; no promete una reactivación soportada."""
    _, c = _cliente(**CON_SESION)
    assert c.get("/chartbay").status_code == 200
    assert c.get("/heatmap").status_code == 200
    assert c.get("/compare").status_code == 200


# ── autenticación ────────────────────────────────────────────────────────────

def test_sin_secciones_con_sesion_no_hay_login():
    _, c = _cliente(**SIN_SESION)
    assert c.get("/login").status_code == 404
    assert c.get("/register").status_code == 404
    assert c.get("/logout").status_code == 405
    assert c.post("/logout").status_code == 404


def test_sin_login_la_barra_no_ofrece_entrar():
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/", "/econometria", "/guia", "/data", "/limpiador"):
        html = c.get(ruta).get_data(as_text=True)
        assert ">Entrar<" not in html, f"{ruta} sigue ofreciendo Entrar"
        assert "/login" not in html, f"{ruta} sigue enlazando a /login"


def test_arranca_sin_credenciales_cuando_no_hay_sesion():
    """Un Blueprint nuevo sin APP_PASSWORD tiene que levantar igual.

    Es la razón por la que APP_USERNAME y APP_PASSWORD salieron de render.yaml:
    con Mercados apagado no hay usuario que sembrar, y exigirlas hacía que un
    despliegue nuevo no arrancara por credenciales que nada iba a leer.
    """
    modulo, c = _cliente(APP_PASSWORD=None, APP_ENV=None, **SIN_SESION)
    assert modulo.AUTH_ENABLED is False
    assert c.get("/").status_code == 200


def test_falta_de_password_falla_al_arrancar_si_hay_sesion():
    """Con Mercados encendido, la contraseña vuelve a ser obligatoria."""
    try:
        _cargar_app(APP_PASSWORD=None, APP_ENV=None, CHARTBAY_SECCIONES="mercados=on")
        raise AssertionError("debía fallar sin APP_PASSWORD y con Mercados encendido")
    except RuntimeError as e:
        assert "APP_PASSWORD" in str(e)


def test_login_valido_abre_sesion():
    _, c = _cliente(**CON_SESION)
    token = _csrf_de(c, "/login")
    r = c.post("/login", data={"username": "juan", "password": "clave-de-test",
                               "_csrf": token})
    assert r.status_code == 302
    with c.session_transaction() as sess:
        assert sess.get("user") == "juan"


def test_logout_es_post_y_no_get():
    _, c = _cliente(**CON_SESION)
    # GET a una ruta que solo acepta POST: 405, no un logout silencioso.
    assert c.get("/logout").status_code == 405


def test_logout_por_post_cierra_la_sesion():
    _, c = _cliente(**CON_SESION)
    token = _csrf_de(c, "/login")
    c.post("/login", data={"username": "juan", "password": "clave-de-test", "_csrf": token})
    r = c.post("/logout", data={"_csrf": token})
    assert r.status_code == 302
    with c.session_transaction() as sess:
        assert "user" not in sess


# ── CSRF ─────────────────────────────────────────────────────────────────────

def _csrf_de(cliente, ruta: str) -> str:
    """Saca el token del formulario renderizado, como haría un navegador."""
    html = cliente.get(ruta).get_data(as_text=True)
    marca = 'name="_csrf" value="'
    i = html.index(marca) + len(marca)
    return html[i:html.index('"', i)]


def test_el_formulario_de_login_trae_token():
    _, c = _cliente(**CON_SESION)
    assert len(_csrf_de(c, "/login")) > 20


def test_post_sin_token_se_rechaza():
    _, c = _cliente(**CON_SESION)
    c.get("/login")  # crea la sesión y su token
    r = c.post("/login", data={"username": "juan", "password": "clave-de-test"})
    assert r.status_code == 400
    with c.session_transaction() as sess:
        assert "user" not in sess


def test_post_con_token_ajeno_se_rechaza():
    _, c = _cliente(**CON_SESION)
    c.get("/login")
    r = c.post("/login", data={"username": "juan", "password": "clave-de-test",
                               "_csrf": "token-de-otra-sesion"})
    assert r.status_code == 400


def test_api_sin_token_responde_json_y_no_html():
    """Las llamadas fetch de Mercados tienen que poder leer el error."""
    _, c = _cliente(**CON_SESION)
    c.get("/login")
    r = c.post("/api/verdict")
    assert r.status_code == 400
    assert r.is_json and "CSRF" in r.get_json()["error"]


def test_el_token_tambien_se_acepta_por_cabecera():
    _, c = _cliente(**CON_SESION)
    token = _csrf_de(c, "/login")
    r = c.post("/api/verdict", headers={"X-CSRF-Token": token})
    # Pasa CSRF; lo que devuelva después es asunto de la ruta (pide login).
    assert r.status_code != 400


def test_sin_sesion_no_se_exige_csrf():
    """La superficie 1.0 no crea sesión y los POST heredados siguen en 404."""
    _, c = _cliente(**SIN_SESION)
    inicio = c.get("/")
    assert "Set-Cookie" not in inicio.headers
    assert c.post("/api/verdict").status_code == 404
    assert c.post("/api/verdict_one?ticker=AAPL").status_code == 404


# ── headers de seguridad ─────────────────────────────────────────────────────

def test_headers_de_seguridad_en_todas_las_rutas():
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/", "/econometria", "/guia", "/data", "/limpiador", "/version"):
        h = c.get(ruta).headers
        assert h["X-Content-Type-Options"] == "nosniff"
        assert h["X-Frame-Options"] == "SAMEORIGIN"
        assert h["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert "Content-Security-Policy" in h


def test_cookie_secure_en_produccion_y_no_en_desarrollo():
    prod = _cargar_app(APP_ENV=None, FLASK_ENV=None, **CON_SESION)
    assert prod.app.config["SESSION_COOKIE_SECURE"] is True
    assert prod.app.config["SESSION_COOKIE_HTTPONLY"] is True
    assert prod.app.config["SESSION_COOKIE_SAMESITE"] == "Lax"
    cookie = prod.app.test_client().get("/login").headers["Set-Cookie"]
    assert "Secure" in cookie and "HttpOnly" in cookie and "SameSite=Lax" in cookie

    dev = _cargar_app(APP_ENV="development", **SIN_SESION)
    # En local el servidor no habla HTTPS: con Secure el navegador descarta la
    # cookie y el login queda inutilizable.
    assert dev.app.config["SESSION_COOKIE_SECURE"] is False


# ── CSP ──────────────────────────────────────────────────────────────────────

def _csp(cliente, ruta: str) -> str:
    return cliente.get(ruta).headers["Content-Security-Policy"]


def test_csp_permite_las_fuentes_que_las_paginas_cargan():
    """Las 17 plantillas linkean Google Fonts; el CSP tiene que dejarlas pasar.

    Son dos orígenes y dos directivas distintas: la hoja de estilos viene de
    fonts.googleapis.com (style-src) y los .woff2 de fonts.gstatic.com
    (font-src). Nombrar solo uno deja el sitio con la fuente de sistema.
    """
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/", "/econometria", "/guia", "/data", "/limpiador"):
        politica = _csp(c, ruta)
        assert "fonts.googleapis.com" in politica.split("style-src")[1].split(";")[0]
        assert "fonts.gstatic.com" in politica.split("font-src")[1].split(";")[0]


def test_csp_sin_tradingview_en_paginas_activas():
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/", "/econometria", "/guia", "/data", "/limpiador"):
        assert "tradingview" not in _csp(c, ruta).lower(), ruta


def test_csp_limita_tradingview_al_comparador_en_override_de_mercados():
    _, c = _cliente(**CON_SESION)
    assert "s3.tradingview.com" in _csp(c, "/compare")
    for ruta in ("/", "/chartbay", "/econometria", "/limpiador", "/data"):
        assert "tradingview" not in _csp(c, ruta).lower(), ruta


def test_csp_del_laboratorio_permite_wasm_sin_abrir_cdn():
    _, c = _cliente(**SIN_SESION)
    politica = _csp(c, "/econometria")
    script = politica.split("script-src")[1].split(";")[0]
    # WebAssembly para el limpiador en C++; las librerías Lite están en bundle.
    assert "'wasm-unsafe-eval'" in script
    assert "jsdelivr" not in script and "cdnjs" not in script
    assert "jsdelivr" not in politica.split("connect-src")[1].split(";")[0]
    # 'unsafe-eval' habilitaría eval() de JavaScript; 'wasm-unsafe-eval' no.
    assert "'unsafe-eval'" not in script


def test_data_cleaner_excel_csv_y_motor_estadistico_disponibles():
    mod = _cargar_app()
    client = mod.app.test_client()
    modern = client.get("/limpiador")
    assert modern.status_code == 200
    assert b'accept=".csv,.xlsx"' in modern.data
    assert b'id="dc-apply"' in modern.data
    assert b'id="dc-undo"' in modern.data
    assert b'id="dc-audit"' in modern.data
    for control in ("dc-rule-add", "dc-outlier-method", "dc-category-add", "dc-recipe-save",
                    "dc-quality-export", "dc-reference-import", "dc-compare-run", "dc-compare-export"):
        assert ('id="' + control + '"').encode() in modern.data
    assert client.get("/static/js/quantbay.data-cleaner.worker.js").status_code == 200
    classic = client.get("/limpiador?motor=estadistico")
    assert classic.status_code == 200
    assert b'data-cleaner-classic' in classic.data
    assert b'id="cl-missing"' in classic.data


def test_csp_del_limpiador_permite_wasm_pero_ningun_cdn():
    """El limpiador sirve sus dos scripts en local: no necesita salir a ningún lado."""
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/limpiador", "/static/js/quantbay.worker.js"):
        script = _csp(c, ruta).split("script-src")[1].split(";")[0]
        assert "'wasm-unsafe-eval'" in script, ruta
        assert "jsdelivr" not in script and "cdnjs" not in script, ruta


def test_csp_del_worker_pro_permite_wasm_sin_abrir_cdn():
    _, c = _cliente(**SIN_SESION)
    politica = _csp(c, "/static/js/quantbay.pro.worker.js")
    script = politica.split("script-src")[1].split(";")[0]
    assert "'wasm-unsafe-eval'" in script
    assert "jsdelivr" not in script and "cdnjs" not in script
    assert "jsdelivr" not in politica.split("connect-src")[1].split(";")[0]


def test_pyodide_vendorizado_se_sirve_con_cache_inmutable():
    _, c = _cliente(**SIN_SESION)
    respuesta = c.get("/static/vendor/pyodide/0.26.4/pyodide.js")
    assert respuesta.status_code == 200
    assert respuesta.headers["Cache-Control"] == "public, max-age=31536000, immutable"

    wasm = c.get("/static/vendor/pyodide/0.26.4/pyodide.asm.wasm")
    assert wasm.status_code == 200
    assert wasm.mimetype == "application/wasm"


def test_csp_de_paginas_simples_no_hereda_permisos_del_laboratorio():
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/", "/guia", "/data"):
        script = _csp(c, ruta).split("script-src")[1].split(";")[0]
        assert "wasm" not in script, ruta
        assert "jsdelivr" not in script and "cdnjs" not in script, ruta


def test_csp_trae_las_directivas_de_endurecimiento():
    _, c = _cliente(**SIN_SESION)
    politica = _csp(c, "/")
    for directiva in ("object-src 'none'", "base-uri 'self'",
                      "form-action 'self'", "frame-ancestors 'none'"):
        assert directiva in politica


def test_csp_usa_nonce_y_no_permite_scripts_inline_globalmente():
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/data", "/guia"):
        respuesta = c.get(ruta)
        politica = respuesta.headers["Content-Security-Policy"]
        script = politica.split("script-src")[1].split(";")[0]
        assert "'unsafe-inline'" not in script
        nonce = re.search(r"'nonce-([^']+)'", script)
        assert nonce
        html = respuesta.get_data(as_text=True)
        assert f'nonce="{nonce.group(1)}"' in html
    estilo = _csp(c, "/").split("style-src")[1].split(";")[0]
    assert "'unsafe-inline'" not in estilo
    assert "script-src-attr 'none'" in _csp(c, "/")
    assert "style-src-attr 'unsafe-inline'" in _csp(c, "/")


def test_guia_tiene_h1_y_ortografia_visible():
    _, c = _cliente(**SIN_SESION)
    html = c.get("/guia").get_data(as_text=True)
    assert re.search(r"<h1[^>]*>\s*Guía de ChartBay", html)
    assert "Especificación" in html and "regresión" in html


def test_dependencias_del_laboratorio_viajan_en_el_bundle_local():
    _, c = _cliente(**SIN_SESION)
    html = c.get("/econometria").get_data(as_text=True)
    assert 'src="/static/js/quantbay.bundle.js"' in html
    for host in ("cdn.jsdelivr.net/npm/papaparse", "cdn.jsdelivr.net/npm/chart.js",
                 "cdnjs.cloudflare.com/ajax/libs/jspdf"):
        assert host not in html


def test_data_no_dispara_consultas_meta_masivas_al_renderizar():
    _, c = _cliente(FRED_API_KEY="clave-invalida", **SIN_SESION)
    html = c.get("/data").get_data(as_text=True)
    assert 'fetch("/api/data/meta/' not in html


# ── /version ─────────────────────────────────────────────────────────────────

def test_version_es_publica_y_sin_secretos():
    """Es el health check de Render y el destino del keep-alive: sin login."""
    _, c = _cliente(**CON_SESION)  # incluso con autenticación encendida
    r = c.get("/version")
    assert r.status_code == 200 and r.is_json
    cuerpo = r.get_json()
    assert set(cuerpo) == {"commit", "commit_short", "branch", "arrancado", "uptime_s"}
    assert isinstance(cuerpo["uptime_s"], int)
    crudo = r.get_data(as_text=True).lower()
    for secreto in ("secret", "password", "api_key", "clave-de-test"):
        assert secreto not in crudo


def test_version_es_barata():
    """El health check corre cada pocos minutos: no debe tocar base ni plantillas."""
    _, c = _cliente(**SIN_SESION)
    r = c.get("/version")
    assert len(r.get_data()) < 400
    assert r.mimetype == "application/json"


# ── /data ────────────────────────────────────────────────────────────────────

def test_data_se_ve_sin_clave_de_fred():
    """Sin FRED_API_KEY, World Bank sigue descargable y solo FRED se apaga."""
    modulo, c = _cliente(FRED_API_KEY=None, **SIN_SESION)
    r = c.get("/data")
    assert r.status_code == 200
    assert modulo._fred_ready() is False
    html = r.get_data(as_text=True)
    inicio = html.index('<script id="fd-bootstrap" type="application/json"')
    inicio = html.index(">", inicio) + 1
    fin = html.index("</script>", inicio)
    bootstrap = json.loads(html[inicio:fin])
    assert "ar_cpi_wb" in bootstrap["downloadableIds"]
    assert "us_cpi" not in bootstrap["downloadableIds"]
    assert "las 12 de World Bank" in html


def test_error_del_laboratorio_usa_paleta_accesible_del_skin_v2():
    css = (ROOT / "web" / "static" / "redesign.css").read_text(encoding="utf-8")
    selector = '[data-skin="v2"] #qb-error'
    bloque = css.split(selector, 1)[1].split("}", 1)[0]
    assert "background:var(--err-100)" in bloque
    assert "color:var(--err)" in bloque

    def luminancia(hex_color: str) -> float:
        canales = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        lineales = [
            canal / 12.92 if canal <= 0.04045 else ((canal + 0.055) / 1.055) ** 2.4
            for canal in canales
        ]
        return 0.2126 * lineales[0] + 0.7152 * lineales[1] + 0.0722 * lineales[2]

    foreground = re.search(r"--err:(#[0-9a-fA-F]{6})", css).group(1)
    background = re.search(r"--err-100:(#[0-9a-fA-F]{6})", css).group(1)
    luces = sorted((luminancia(foreground), luminancia(background)))
    contraste = (luces[1] + 0.05) / (luces[0] + 0.05)
    assert contraste >= 3, contraste


def test_catalogo_de_data_sin_red():
    _, c = _cliente(**SIN_SESION)
    r = c.get("/api/data/catalog")
    assert r.status_code == 200 and r.get_json()["ok"] is True
    cuerpo = r.get_json()
    assert len(cuerpo["catalog"]) > 0
    assert {"fred", "worldbank"} <= {s["code"] for s in cuerpo["sources"]}


def test_indicador_desconocido_es_404_y_no_error_de_servidor():
    _, c = _cliente(**SIN_SESION)
    for ruta in ("/api/data/series/no_existe", "/api/data/meta/no_existe"):
        r = c.get(ruta)
        assert r.status_code == 404 and r.get_json()["ok"] is False
    assert c.get("/api/data/download/no_existe").status_code == 404


def test_id_de_indicador_invalido_no_llega_al_proveedor():
    """El regex corta traversal e inyección antes de resolver el catálogo."""
    _, c = _cliente(**SIN_SESION)
    for malo in ("../../etc/passwd", "MAYUSCULAS", "con espacio", "a" * 41):
        assert c.get(f"/api/data/series/{malo}").status_code in (404, 400)


def test_formato_de_descarga_no_soportado():
    _, c = _cliente(**SIN_SESION)
    r = c.get("/api/data/download/us_cpi?format=exe")
    # 400 por formato, o 404 si ese id no está en el catálogo actual.
    assert r.status_code in (400, 404)


# ── feature flags ────────────────────────────────────────────────────────────

def test_los_flags_por_defecto_son_el_alcance_de_1_0():
    modulo = _cargar_app(**SIN_SESION)
    assert modulo.SECCIONES == {
        "econometria": True,
        "limpiador": True,
        "datos": True,
        "agro": False,
        "mercados": False,
    }


def test_override_por_entorno_solo_controla_mercados():
    modulo = _cargar_app(CHARTBAY_SECCIONES="mercados=on,agro=on,econometria=off",
                         APP_PASSWORD="clave-de-test")
    assert modulo.SECCIONES["mercados"] is True
    assert modulo.SECCIONES["agro"] is False
    assert modulo.SECCIONES["econometria"] is True


def test_override_con_nombre_inexistente_no_rompe_el_arranque():
    modulo = _cargar_app(CHARTBAY_SECCIONES="seccion_que_no_existe=on")
    assert "seccion_que_no_existe" not in modulo.SECCIONES
    assert modulo.app.test_client().get("/").status_code == 200


def test_fetch_heredado_de_veredictos_envia_csrf():
    html = (ROOT / "web" / "templates" / "dashboard.html").read_text(encoding="utf-8")
    assert '"X-CSRF-Token": CSRF_TOKEN' in html


def test_auth_enabled_sigue_a_mercados():
    assert _cargar_app(**SIN_SESION).AUTH_ENABLED is False
    assert _cargar_app(**CON_SESION).AUTH_ENABLED is True


def test_sin_sesion_no_se_abre_la_base():
    """SQLite solo lo usan la autenticación y la comunidad, las dos de Mercados."""
    base = _TMP / "no-deberia-existir.db"
    if base.exists():
        base.unlink()
    import db
    db.DB_PATH = base
    _cargar_app(**SIN_SESION)
    assert not base.exists(), "se abrió SQLite sin ninguna sección que lo use"


# ── runner propio (no requiere pytest) ───────────────────────────────────────

def _run():
    tests = [v for k, v in sorted(globals().items())
             if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL  {t.__name__}: {e}")
    total = len(tests)
    print(f"\n{total - failed}/{total} tests OK")
    shutil.rmtree(_TMP, ignore_errors=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    _run()
