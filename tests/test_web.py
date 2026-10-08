"""
Tests de la app Flask: rutas activas, secciones apagadas, headers y CSP.

Se puede correr de dos formas, igual que tests/test_providers.py:
    python tests/test_web.py         # runner propio, sin dependencias
    pytest tests/test_web.py         # si tenés pytest instalado

Necesita Flask (está en requirements.txt) pero NO necesita scipy ni
statsmodels: acá no se calcula nada, solo se verifican respuestas HTTP.

Parte del arranque se resuelve en el import de `web.app` a partir del entorno
(qué proveedores de Datos quedan disponibles, por ejemplo), así que los tests
reimportan el módulo con el entorno que necesitan (`_cargar_app`).
"""
import gzip
import importlib
import io
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))


def _cargar_app(**overrides):
    """Reimporta web.app con las variables de entorno pedidas.

    Devuelve el módulo ya recargado. Las claves con valor None se borran del
    entorno, que es como se prueba "esta variable no está definida".
    """
    previo = {}
    for k, v in overrides.items():
        previo[k] = os.environ.get(k)
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
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


def _cliente_con_datos(**overrides):
    """Cliente con la sección Datos encendida.

    Datos está escondida (`SECCIONES["datos"] = False`) pero no borrada: estos
    tests la encienden para que su código no se pudra mientras tanto. Alcanza
    con tocar el diccionario después del import porque `seccion()` lo lee en
    cada request.
    """
    modulo, c = _cliente(**overrides)
    modulo.SECCIONES["datos"] = True
    return modulo, c


# ── rutas activas ────────────────────────────────────────────────────────────

def test_rutas_activas_responden_200():
    _, c = _cliente()
    for ruta in ("/", "/version", "/guia", "/econometria", "/limpiador"):
        assert c.get(ruta).status_code == 200, f"{ruta} no devolvió 200"


def test_paginas_activas_ofrecen_el_codigo_fuente():
    _, c = _cliente()
    for ruta in ("/", "/guia", "/econometria", "/limpiador"):
        html = c.get(ruta).get_data(as_text=True)
        assert 'href="/source.tar.gz"' in html, ruta
        assert 'rel="source"' in html and "Código fuente" in html, ruta


def test_archivo_de_fuente_incluye_licencia_y_excluye_estado_local():
    _, c = _cliente()
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
        "quantbay/src/chartpython/kernel.ts",
        "quantbay/src/chartpython/ui/app.ts",
        "web/static/js/chartpython.js",
        "web/static/js/chartpython.worker.js",
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
    _, c = _cliente()
    r = c.get("/quantbay")
    assert r.status_code == 302
    assert r.headers["Location"].endswith("/econometria")


def test_datasets_solo_sirve_los_casos_del_catalogo():
    _, c = _cliente()
    assert c.get("/datasets/01_simple_linear.csv").status_code == 200
    # No está en la lista blanca: no existe como caso de práctica.
    assert c.get("/datasets/otro.csv").status_code == 404
    # Traversal: la lista blanca lo corta antes de tocar el filesystem.
    assert c.get("/datasets/../README.md").status_code in (301, 308, 404)


# ── secciones apagadas y código borrado ──────────────────────────────────────

def test_secciones_apagadas_devuelven_404():
    _, c = _cliente()
    apagadas = ("/data", "/api/data/catalog", "/api/data/series/us_cpi",
                "/api/data/meta/us_cpi", "/api/data/download/us_cpi")
    for ruta in apagadas:
        assert c.get(ruta).status_code == 404, f"{ruta} debía estar apagada"


def test_rutas_de_mercados_ya_no_existen():
    """Mercados se borró: ni con el override viejo en el entorno vuelve una ruta."""
    _, c = _cliente(CHARTBAY_SECCIONES="mercados=on")
    for ruta in ("/chartbay", "/finanzas", "/reports", "/reportes", "/community",
                 "/community/new", "/community/bot/1", "/compare", "/comparar",
                 "/heatmap", "/api/snapshot", "/api/lookup", "/api/news",
                 "/api/verdict", "/login", "/register"):
        assert c.get(ruta).status_code == 404, ruta
    for ruta in ("/api/verdict", "/api/verdict_one", "/login", "/logout"):
        assert c.post(ruta).status_code == 404, ruta


def test_secciones_apagadas_no_aparecen_en_el_menu():
    _, c = _cliente()
    html = c.get("/").get_data(as_text=True)
    assert "Econometría" in html and "Limpiador" in html
    for ausente in (">Datos<", 'href="/finanzas"', 'href="/community"',
                    'href="/login"', ">Entrar<"):
        assert ausente not in html, ausente


def test_datos_escondida_no_se_enlaza_desde_ninguna_pagina():
    """Ni la pestaña ni la fila de Inicio: nada tiene que llevar a una ruta 404."""
    _, c = _cliente()
    for ruta in ("/", "/guia", "/econometria", "/limpiador"):
        html = c.get(ruta).get_data(as_text=True)
        assert 'href="/data"' not in html, ruta


def test_ninguna_pagina_deja_cookies():
    """Sin login ni sesión, el sitio no tiene nada que guardar en el navegador."""
    _, c = _cliente()
    for ruta in ("/", "/econometria", "/guia", "/limpiador", "/version"):
        assert "Set-Cookie" not in c.get(ruta).headers, ruta


def test_arranca_sin_ninguna_variable_de_entorno():
    """Un Blueprint nuevo tiene que levantar sin configurar nada, en modo producción."""
    _, c = _cliente(SECRET_KEY=None, APP_ENV=None, FLASK_ENV=None,
                    APP_PASSWORD=None, FRED_API_KEY=None)
    assert c.get("/").status_code == 200


# ── headers de seguridad ─────────────────────────────────────────────────────

def test_headers_de_seguridad_en_todas_las_rutas():
    _, c = _cliente_con_datos()
    for ruta in ("/", "/econometria", "/guia", "/data", "/limpiador", "/version"):
        h = c.get(ruta).headers
        assert h["X-Content-Type-Options"] == "nosniff"
        assert h["X-Frame-Options"] == "SAMEORIGIN"
        assert h["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert "Content-Security-Policy" in h


# ── CSP ──────────────────────────────────────────────────────────────────────

def _csp(cliente, ruta: str) -> str:
    return cliente.get(ruta).headers["Content-Security-Policy"]


def test_csp_permite_las_fuentes_que_las_paginas_cargan():
    """Las plantillas linkean Google Fonts; el CSP tiene que dejarlas pasar.

    Son dos orígenes y dos directivas distintas: la hoja de estilos viene de
    fonts.googleapis.com (style-src) y los .woff2 de fonts.gstatic.com
    (font-src). Nombrar solo uno deja el sitio con la fuente de sistema.
    """
    _, c = _cliente_con_datos()
    for ruta in ("/", "/econometria", "/guia", "/data", "/limpiador"):
        politica = _csp(c, ruta)
        assert "fonts.googleapis.com" in politica.split("style-src")[1].split(";")[0]
        assert "fonts.gstatic.com" in politica.split("font-src")[1].split(";")[0]


def test_csp_no_abre_terceros_ni_frames():
    _, c = _cliente_con_datos()
    for ruta in ("/", "/econometria", "/guia", "/data", "/limpiador"):
        politica = _csp(c, ruta)
        assert "tradingview" not in politica.lower(), ruta
        assert "frame-src 'none'" in politica, ruta


def test_csp_del_laboratorio_permite_wasm_sin_abrir_cdn():
    _, c = _cliente()
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
    _, c = _cliente()
    for ruta in ("/limpiador", "/static/js/quantbay.worker.js"):
        script = _csp(c, ruta).split("script-src")[1].split(";")[0]
        assert "'wasm-unsafe-eval'" in script, ruta
        assert "jsdelivr" not in script and "cdnjs" not in script, ruta


def test_csp_del_worker_pro_permite_wasm_sin_abrir_cdn():
    _, c = _cliente()
    politica = _csp(c, "/static/js/quantbay.pro.worker.js")
    script = politica.split("script-src")[1].split(";")[0]
    assert "'wasm-unsafe-eval'" in script
    assert "jsdelivr" not in script and "cdnjs" not in script
    assert "jsdelivr" not in politica.split("connect-src")[1].split(";")[0]


def test_pyodide_vendorizado_se_sirve_con_cache_inmutable():
    _, c = _cliente()
    respuesta = c.get("/static/vendor/pyodide/0.26.4/pyodide.js")
    assert respuesta.status_code == 200
    assert respuesta.headers["Cache-Control"] == "public, max-age=31536000, immutable"

    wasm = c.get("/static/vendor/pyodide/0.26.4/pyodide.asm.wasm")
    assert wasm.status_code == 200
    assert wasm.mimetype == "application/wasm"


def test_csp_de_paginas_simples_no_hereda_permisos_del_laboratorio():
    _, c = _cliente_con_datos()
    for ruta in ("/", "/guia", "/data"):
        script = _csp(c, ruta).split("script-src")[1].split(";")[0]
        assert "wasm" not in script, ruta
        assert "jsdelivr" not in script and "cdnjs" not in script, ruta


def test_csp_trae_las_directivas_de_endurecimiento():
    _, c = _cliente()
    politica = _csp(c, "/")
    for directiva in ("object-src 'none'", "base-uri 'self'",
                      "form-action 'self'", "frame-ancestors 'none'"):
        assert directiva in politica


def test_csp_usa_nonce_y_no_permite_scripts_inline_globalmente():
    _, c = _cliente_con_datos()
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
    _, c = _cliente()
    html = c.get("/guia").get_data(as_text=True)
    assert re.search(r"<h1[^>]*>\s*Guía de ChartBay", html)
    assert "Especificación" in html and "regresión" in html


def test_dependencias_del_laboratorio_viajan_en_el_bundle_local():
    _, c = _cliente()
    html = c.get("/econometria").get_data(as_text=True)
    assert 'src="/static/js/quantbay.bundle.js"' in html
    for host in ("cdn.jsdelivr.net/npm/papaparse", "cdn.jsdelivr.net/npm/chart.js",
                 "cdnjs.cloudflare.com/ajax/libs/jspdf"):
        assert host not in html


def test_data_no_dispara_consultas_meta_masivas_al_renderizar():
    _, c = _cliente_con_datos(FRED_API_KEY="clave-invalida")
    html = c.get("/data").get_data(as_text=True)
    assert 'fetch("/api/data/meta/' not in html


# ── /version ─────────────────────────────────────────────────────────────────

def test_version_es_publica_y_sin_secretos():
    """Es el health check de Render y el destino del keep-alive: sin login."""
    _, c = _cliente()
    r = c.get("/version")
    assert r.status_code == 200 and r.is_json
    cuerpo = r.get_json()
    assert set(cuerpo) == {"commit", "commit_short", "branch", "arrancado", "uptime_s"}
    assert isinstance(cuerpo["uptime_s"], int)
    crudo = r.get_data(as_text=True).lower()
    for secreto in ("secret", "password", "api_key"):
        assert secreto not in crudo


def test_version_es_barata():
    """El health check corre cada pocos minutos: no debe tocar plantillas."""
    _, c = _cliente()
    r = c.get("/version")
    assert len(r.get_data()) < 400
    assert r.mimetype == "application/json"


# ── /data ────────────────────────────────────────────────────────────────────

def test_data_se_ve_sin_clave_de_fred():
    """Sin FRED_API_KEY, World Bank sigue descargable y solo FRED se apaga."""
    modulo, c = _cliente_con_datos(FRED_API_KEY=None)
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
    _, c = _cliente_con_datos()
    r = c.get("/api/data/catalog")
    assert r.status_code == 200 and r.get_json()["ok"] is True
    cuerpo = r.get_json()
    assert len(cuerpo["catalog"]) > 0
    assert {"fred", "worldbank"} <= {s["code"] for s in cuerpo["sources"]}


def test_indicador_desconocido_es_404_y_no_error_de_servidor():
    _, c = _cliente_con_datos()
    for ruta in ("/api/data/series/no_existe", "/api/data/meta/no_existe"):
        r = c.get(ruta)
        assert r.status_code == 404 and r.get_json()["ok"] is False
    assert c.get("/api/data/download/no_existe").status_code == 404


def test_id_de_indicador_invalido_no_llega_al_proveedor():
    """El regex corta traversal e inyección antes de resolver el catálogo."""
    _, c = _cliente_con_datos()
    for malo in ("../../etc/passwd", "MAYUSCULAS", "con espacio", "a" * 41):
        assert c.get(f"/api/data/series/{malo}").status_code in (404, 400)


def test_formato_de_descarga_no_soportado():
    _, c = _cliente_con_datos()
    r = c.get("/api/data/download/us_cpi?format=exe")
    # 400 por formato, o 404 si ese id no está en el catálogo actual.
    assert r.status_code in (400, 404)


# ── secretos ─────────────────────────────────────────────────────────────────

# Con forma de clave real para que un filtro por patrón también la vea.
_CLAVE_FALSA = "sk-ant-api03-" + "x" * 40 + "-FALSA"


def test_ningun_archivo_versionado_lee_ni_contiene_una_clave_de_anthropic():
    """El código que leía ANTHROPIC_API_KEY se borró con Mercados; que no vuelva."""
    patron = re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}")
    salida = subprocess.run(["git", "ls-files", "-z"], cwd=ROOT, capture_output=True, check=True).stdout
    for crudo in filter(None, salida.split(b"\0")):
        rel = crudo.decode("utf-8")
        ruta = ROOT / rel
        if rel.startswith("web/static/vendor/") or not ruta.is_file():
            continue
        if ruta.suffix in {".whl", ".wasm", ".png", ".jpg", ".zip", ".gz"}:
            continue
        texto = ruta.read_text(encoding="utf-8", errors="ignore")
        assert not patron.search(texto), f"{rel} contiene algo con forma de clave de Anthropic"
        if ruta.suffix in {".py", ".ts", ".js", ".html"} and ruta.name != "test_web.py":
            assert "ANTHROPIC_API_KEY" not in texto, rel
            assert not re.search(r"^\s*(import|from)\s+anthropic\b", texto, re.M), rel


def test_una_clave_en_el_entorno_no_aparece_en_ninguna_respuesta():
    """Aunque alguien cargue ANTHROPIC_API_KEY en Render, nada la devuelve al cliente."""
    previa = os.environ.get("ANTHROPIC_API_KEY")
    os.environ["ANTHROPIC_API_KEY"] = _CLAVE_FALSA
    try:
        modulo, c = _cliente_con_datos(RENDER="true")
        # Con debug, un error mostraría el depurador de Werkzeug y su consola.
        assert modulo.app.debug is False
        for ruta in ("/", "/econometria", "/guia", "/limpiador", "/data", "/version",
                     "/api/data/catalog", "/no-existe", "/static/js/quantbay.bundle.js",
                     "/static/js/quantbay.cleaner.js", "/static/js/quantbay.worker.js",
                     "/static/js/quantbay.pro.worker.js",
                     "/static/js/quantbay.data-cleaner.worker.js", "/source.tar.gz"):
            r = c.get(ruta)
            cuerpo = r.get_data()
            if ruta.endswith(".gz"):
                cuerpo = gzip.decompress(cuerpo)
            assert _CLAVE_FALSA.encode() not in cuerpo, ruta
            assert not any(_CLAVE_FALSA in valor for valor in r.headers.values()), ruta
            if not ruta.endswith(".gz"):
                # El archivo de fuente trae este mismo test, que nombra el prefijo;
                # en el resto de las respuestas no tiene por qué aparecer ni eso.
                assert b"sk-ant-" not in cuerpo, ruta
    finally:
        if previa is None:
            os.environ.pop("ANTHROPIC_API_KEY", None)
        else:
            os.environ["ANTHROPIC_API_KEY"] = previa


# ── límite de solicitudes por IP ─────────────────────────────────────────────

class _Reloj:
    """Reloj que avanza sólo cuando el test lo mueve."""

    def __init__(self, t: float = 1000.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


def _cliente_con_limite(limite=3, ventana_s=60, **overrides):
    """Cliente con un limitador chico, para no tener que hacer 120 requests."""
    from rate_limit import Limitador, Regla
    modulo, c = _cliente(**overrides)
    reloj = _Reloj()
    modulo.LIMITADOR = Limitador(
        (Regla("general", limite=limite, ventana_s=ventana_s),
         Regla("fuente", limite=1, ventana_s=ventana_s, rutas=("/source.tar.gz",))),
        reloj=reloj,
    )
    return modulo, c, reloj


def test_los_limites_por_defecto_cubren_una_visita_real():
    modulo = _cargar_app()
    limitador = modulo.LIMITADOR
    assert limitador.regla_para("/econometria").limite == 120
    assert limitador.regla_para("/static/vendor/pyodide/0.26.4/pyodide.js").limite == 600
    assert limitador.regla_para("/source.tar.gz").limite == 10
    assert limitador.regla_para("/api/data/catalog").limite == 30
    # /datasets empieza como /data pero son los casos de práctica: regla general.
    assert limitador.regla_para("/datasets/01_simple_linear.csv").nombre == "general"


def test_pasado_el_limite_responde_429_con_retry_after():
    _, c, _ = _cliente_con_limite(limite=3)
    for _ in range(3):
        assert c.get("/version").status_code == 200
    r = c.get("/version")
    assert r.status_code == 429
    assert int(r.headers["Retry-After"]) >= 1
    # El rechazo también lleva las cabeceras de seguridad.
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert "Content-Security-Policy" in r.headers


def test_el_limite_en_la_api_responde_json():
    _, c, _ = _cliente_con_limite(limite=1)
    c.get("/api/data/catalog")
    r = c.get("/api/data/catalog")
    assert r.status_code == 429 and r.is_json and r.get_json()["ok"] is False


def test_el_limite_es_por_ip():
    _, c, _ = _cliente_con_limite(limite=1)
    uno, otro = {"REMOTE_ADDR": "203.0.113.1"}, {"REMOTE_ADDR": "203.0.113.2"}
    assert c.get("/version", environ_base=uno).status_code == 200
    assert c.get("/version", environ_base=uno).status_code == 429
    assert c.get("/version", environ_base=otro).status_code == 200


def test_la_ventana_se_desliza_y_vuelve_a_dejar_pasar():
    _, c, reloj = _cliente_con_limite(limite=2, ventana_s=60)
    assert c.get("/version").status_code == 200
    assert c.get("/version").status_code == 200
    assert c.get("/version").status_code == 429
    reloj.t += 120  # dos ventanas después no queda rastro de las anteriores
    assert c.get("/version").status_code == 200


def test_el_archivo_de_fuente_tiene_un_limite_propio():
    _, c, _ = _cliente_con_limite(limite=100)
    assert c.get("/source.tar.gz").status_code == 200
    assert c.get("/source.tar.gz").status_code == 429
    # Agotar esa regla no le cierra el resto del sitio a la misma IP.
    assert c.get("/version").status_code == 200


def test_sin_render_no_se_confia_en_cabeceras_de_ip():
    """Fuera de Render, inventar un CF-Connecting-IP no sirve para esquivar el límite."""
    _, c, _ = _cliente_con_limite(limite=1, RENDER=None)
    assert c.get("/version", headers={"CF-Connecting-IP": "198.51.100.1"}).status_code == 200
    assert c.get("/version", headers={"CF-Connecting-IP": "198.51.100.2"}).status_code == 429


def test_en_render_cuenta_la_ip_que_escribe_cloudflare():
    _, c, _ = _cliente_con_limite(limite=1, RENDER="true")
    assert c.get("/version", headers={"CF-Connecting-IP": "198.51.100.1"}).status_code == 200
    assert c.get("/version", headers={"CF-Connecting-IP": "198.51.100.2"}).status_code == 200
    assert c.get("/version", headers={"CF-Connecting-IP": "198.51.100.1"}).status_code == 429


def test_cabecera_de_ip_invalida_cae_a_la_siguiente():
    from rate_limit import ip_del_cliente
    cabeceras = {"CF-Connecting-IP": "no-es-una-ip", "X-Forwarded-For": "198.51.100.7, 10.0.0.1"}
    assert ip_del_cliente(cabeceras, "10.0.0.1", detras_de_render=True) == "198.51.100.7"


def test_ipv6_cuenta_por_prefijo_64():
    from rate_limit import ip_del_cliente
    a = ip_del_cliente({}, "2001:db8:1:2::1", detras_de_render=False)
    b = ip_del_cliente({}, "2001:db8:1:2:ffff::9", detras_de_render=False)
    assert a == b == "2001:db8:1:2::/64"


def test_la_memoria_del_limitador_esta_acotada():
    from rate_limit import Limitador, Regla
    limitador = Limitador((Regla("general", limite=5, ventana_s=60),), max_claves=100)
    for i in range(1000):
        limitador.registrar("/", f"10.0.{i // 256}.{i % 256}")
    assert len(limitador) == 100


# ── feature flags ────────────────────────────────────────────────────────────

def test_los_flags_por_defecto_son_el_alcance_publicado():
    modulo = _cargar_app()
    assert modulo.SECCIONES == {"datos": False, "chartpython": True, "base_datos": True}


# ── ChartPython ──────────────────────────────────────────────────────────────

def test_chartpython_sirve_su_pagina_y_sus_artefactos():
    _, c = _cliente()
    html = c.get("/chartpython").get_data(as_text=True)
    assert "data-chartpython" in html
    assert "/static/js/chartpython.js" in html
    for archivo in ("/static/js/chartpython.js", "/static/js/chartpython.worker.js", "/static/chartpython.css"):
        assert c.get(archivo).status_code == 200, archivo


def test_csp_de_chartpython_permite_wasm_sin_abrir_cdn():
    """La página y el worker compilan WebAssembly; el worker usa su propia CSP."""
    _, c = _cliente()
    for ruta in ("/chartpython", "/static/js/chartpython.worker.js"):
        politica = _csp(c, ruta)
        script = politica.split("script-src")[1].split(";")[0]
        assert "'wasm-unsafe-eval'" in script, ruta
        assert "jsdelivr" not in politica and "cdnjs" not in politica, ruta
        assert "'self'" in politica.split("connect-src")[1].split(";")[0], ruta


def test_chartpython_aparece_en_el_menu_y_en_inicio():
    _, c = _cliente()
    assert 'href="/chartpython"' in c.get("/").get_data(as_text=True)
    assert 'href="/chartpython"' in c.get("/limpiador").get_data(as_text=True)
    assert "<strong>ChartPython</strong>" in c.get("/chartpython").get_data(as_text=True)


def test_chartpython_se_puede_apagar_sin_borrar_nada():
    modulo, c = _cliente()
    modulo.SECCIONES["chartpython"] = False
    try:
        for ruta in ("/chartpython", "/chartpython/manual", "/chartpython/manual.ipynb"):
            assert c.get(ruta).status_code == 404, ruta
        for ruta in ("/", "/limpiador", "/guia"):
            html = c.get(ruta).get_data(as_text=True)
            assert 'href="/chartpython"' not in html, ruta
            assert 'href="/chartpython/manual"' not in html, ruta
    finally:
        modulo.SECCIONES["chartpython"] = True


# ── Manual de ChartPython ────────────────────────────────────────────────────
# Que cada ejemplo corra en Pyodide lo prueba quantbay/tests/chartpython/manual.test.ts;
# acá, que la página y el notebook muestren exactamente esos ejemplos.

def _ejemplos_del_manual(solo_ejecutables=False):
    from chartpython_manual import PLANTILLA, bloques

    return [
        bloque["texto"].strip()
        for bloque in bloques(PLANTILLA.read_text(encoding="utf-8"))
        if bloque["macro"] == "py"
        and not (solo_ejecutables and (bloque["opciones"].get("error") or bloque["opciones"].get("ejecutar") is False))
    ]


def test_manual_de_chartpython_se_sirve_y_se_enlaza():
    _, c = _cliente()
    respuesta = c.get("/chartpython/manual")
    assert respuesta.status_code == 200
    html = respuesta.get_data(as_text=True)
    assert re.search(r"<h1[^>]*>\s*Manual de ChartPython", html)
    assert 'href="/chartpython/manual.ipynb"' in html
    assert c.get("/static/chartpython-manual.css").status_code == 200
    for ruta in ("/chartpython", "/guia"):
        assert 'href="/chartpython/manual"' in c.get(ruta).get_data(as_text=True), ruta


def test_csp_del_manual_no_pide_wasm_y_su_script_lleva_nonce():
    _, c = _cliente()
    respuesta = c.get("/chartpython/manual")
    script = respuesta.headers["Content-Security-Policy"].split("script-src")[1].split(";")[0]
    assert "wasm" not in script and "'unsafe-inline'" not in script
    nonce = re.search(r"'nonce-([^']+)'", script).group(1)
    assert f'<script nonce="{nonce}">' in respuesta.get_data(as_text=True)


def test_indice_del_manual_sigue_el_orden_de_los_temas():
    _, c = _cliente()
    html = c.get("/chartpython/manual").get_data(as_text=True)
    indice = html.split('class="cpm-indice"', 1)[1].split("</nav>", 1)[0]
    enlaces = re.findall(r'href="#([\w-]+)"', indice)
    temas = re.findall(r'class="cpm-tema" id="([\w-]+)"', html)
    assert len(temas) > 30
    assert enlaces == temas


def test_la_pagina_muestra_los_ejemplos_tal_como_se_ejecutan():
    """El código llega escapado al HTML y, desescapado, es el mismo que corre la prueba de Pyodide."""
    from html import unescape

    _, c = _cliente()
    html = c.get("/chartpython/manual").get_data(as_text=True)
    mostrados = [unescape(codigo) for codigo in re.findall(r'<pre class="cpm-code"><code>(.*?)</code></pre>', html, re.S)]
    ejemplos = _ejemplos_del_manual()
    assert len(ejemplos) > 100
    assert mostrados == ejemplos


def test_notebook_del_manual_trae_solo_los_ejemplos_que_corren():
    _, c = _cliente()
    respuesta = c.get("/chartpython/manual.ipynb")
    assert respuesta.status_code == 200
    assert respuesta.mimetype == "application/x-ipynb+json"
    assert respuesta.headers["Content-Disposition"] == 'attachment; filename="Manual de ChartPython.ipynb"'
    notebook = json.loads(respuesta.get_data(as_text=True))
    assert notebook["nbformat"] == 4
    ids = [celda["id"] for celda in notebook["cells"]]
    assert len(ids) == len(set(ids))
    assert all(re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", i) for i in ids)
    codigo = ["".join(celda["source"]) for celda in notebook["cells"] if celda["cell_type"] == "code"]
    assert codigo == _ejemplos_del_manual(solo_ejecutables=True)
    assert len(codigo) < len(_ejemplos_del_manual())
    assert not any("while True" in celda or "input(" in celda for celda in codigo)
    assert all(celda["outputs"] == [] for celda in notebook["cells"] if celda["cell_type"] == "code")


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
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    _run()
