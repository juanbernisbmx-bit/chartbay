"""El latido hacia el monitor externo: cada comprobación, el resumen, el latido y la línea de comandos.

Los servidores (el /salud del equipo, el HTTPS público y el monitor) son falsos y locales; el HTTPS usa un certificado que se
genera con openssl. La base es la de las pruebas (DATOS_TEST_DATABASE_URL)."""
import contextlib
import io
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from servicio_datos import latido, monitor, tarea
from servicio_datos.monitor import ADVERTENCIA, FALLA, OK, OMITIDO, ErrorLatido, Resultado
from servicio_datos.tests.base import URL, BaseEsquema

AHORA = datetime.now(timezone.utc)


class Servidor:
    """Un servidor HTTP(S) local que guarda lo que recibe y responde lo que se le diga, por ruta (una lista se consume en orden)."""

    def __init__(self, respuestas=None, contexto=None):
        self.pedidos, self.respuestas = [], dict(respuestas or {})
        yo = self

        class Manejador(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def responder(self):
                largo = int(self.headers.get("Content-Length") or 0)
                yo.pedidos.append((self.command, self.path, self.rfile.read(largo).decode("utf-8") if largo else ""))
                respuesta = yo.respuestas.get(self.path, (404, "no está"))
                if isinstance(respuesta, list):
                    respuesta = respuesta.pop(0) if len(respuesta) > 1 else respuesta[0]
                estado, cuerpo, *cabeceras = respuesta
                self.send_response(estado)
                for clave, valor in (cabeceras[0] if cabeceras else {}).items():
                    self.send_header(clave, valor)
                self.send_header("Content-Length", str(len(cuerpo.encode())))
                self.end_headers()
                self.wfile.write(cuerpo.encode())

            do_GET = do_POST = responder

        self.servidor = ThreadingHTTPServer(("127.0.0.1", 0), Manejador)
        if contexto:
            self.servidor.socket = contexto.wrap_socket(self.servidor.socket, server_side=True)
        self.puerto = self.servidor.server_port
        self.url = f"{'https' if contexto else 'http'}://{'localhost' if contexto else '127.0.0.1'}:{self.puerto}"
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()

    def cerrar(self):
        self.servidor.shutdown()
        self.servidor.server_close()


class ConServidores(unittest.TestCase):
    def servidor(self, respuestas=None, contexto=None):
        servidor = Servidor(respuestas, contexto)
        self.addCleanup(servidor.cerrar)
        return servidor

    def carpeta(self):
        ruta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, ruta, ignore_errors=True)
        return ruta


class SaludLocalTests(ConServidores):
    def test_responde_ok(self):
        servidor = self.servidor({"/salud": (200, "ok")})
        self.assertEqual(monitor.comprobar_salud_local(servidor.url + "/salud"), Resultado("revisión local", OK, "responde"))

    def test_lo_que_no_es_ok_es_una_falla(self):
        casos = {"error": ((500, "boom"), "HTTP 500"), "otra cosa": ((200, "página de login"), "en vez de «ok»"),
                 "redirección": ((302, "", {"Location": "http://otro.example/"}), "HTTP 302")}
        for nombre, (respuesta, esperado) in casos.items():
            servidor = self.servidor({"/salud": respuesta})
            resultado = monitor.comprobar_salud_local(servidor.url + "/salud")
            self.assertEqual(resultado.estado, FALLA, nombre)
            self.assertIn(esperado, resultado.detalle, nombre)

    def test_si_el_servicio_no_esta_dice_que_mirar(self):
        resultado = monitor.comprobar_salud_local("http://127.0.0.1:1/salud")
        self.assertEqual(resultado.estado, FALLA)
        self.assertIn("systemctl status chartbay-revision", resultado.detalle)

    def test_contra_la_interfaz_de_revision_de_verdad(self):
        from werkzeug.security import generate_password_hash
        from werkzeug.serving import make_server

        from servicio_datos.revision import crear_app
        app = crear_app("postgresql://nadie@127.0.0.1:1/nada", {"juani": generate_password_hash("x" * 12, method="pbkdf2:sha256:1000")})
        servidor = make_server("127.0.0.1", 0, app)
        threading.Thread(target=servidor.serve_forever, daemon=True).start()
        self.addCleanup(servidor.shutdown)
        self.assertEqual(monitor.comprobar_salud_local(f"http://127.0.0.1:{servidor.server_port}/salud").estado, OK)  # sin base y sin clave: /salud es del proceso


def _certificado(carpeta, dias):
    """Un certificado autofirmado para localhost que vence en `dias`. None si no hay openssl que lo sepa hacer."""
    clave, certificado = carpeta / f"clave-{dias}.pem", carpeta / f"cert-{dias}.pem"
    try:
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(clave), "-out", str(certificado), "-days", str(dias),
                        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:TRUE"],
                       check=True, capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return clave, certificado


class SaludPublicaTests(ConServidores):
    def https(self, dias, respuesta=(200, "ok")):
        archivos = _certificado(self.carpeta(), dias)
        if archivos is None:
            self.skipTest("Hace falta openssl para generar un certificado de prueba")
        contexto = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        contexto.load_cert_chain(archivos[1], archivos[0])
        servidor = self.servidor({"/salud": respuesta}, contexto)
        return servidor, ssl.create_default_context(cafile=str(archivos[1]))

    def test_responde_y_dice_cuando_vence_el_certificado(self):
        servidor, confianza = self.https(90)
        resultado = monitor.comprobar_salud_publica(servidor.url, AHORA, confianza)
        self.assertEqual(resultado.estado, OK)
        self.assertRegex(resultado.detalle, r"^responde; el certificado vence en (89|90) días$")

    def test_un_certificado_que_vence_pronto_avisa_y_uno_por_vencer_falla(self):
        for dias, estado in ((15, ADVERTENCIA), (5, FALLA)):
            servidor, confianza = self.https(dias)
            resultado = monitor.comprobar_salud_publica(servidor.url + "/", AHORA, confianza)
            self.assertEqual(resultado.estado, estado, dias)
            self.assertRegex(resultado.detalle, rf"vence en ({dias - 1}|{dias}) días")

    def test_un_certificado_que_no_es_de_confianza_falla(self):
        servidor, _ = self.https(90)
        resultado = monitor.comprobar_salud_publica(servidor.url, AHORA)  # con las autoridades del sistema
        self.assertEqual(resultado.estado, FALLA)
        self.assertIn("no es válido", resultado.detalle)

    def test_si_responde_otra_cosa_falla(self):
        servidor, confianza = self.https(90, respuesta=(502, "Bad Gateway"))
        self.assertIn("respondió 502", monitor.comprobar_salud_publica(servidor.url, AHORA, confianza).detalle)

    def test_si_no_responde_dice_que_mirar(self):
        resultado = monitor.comprobar_salud_publica("https://localhost:1", AHORA)
        self.assertEqual(resultado.estado, FALLA)
        self.assertIn("¿Caddy, la red o el túnel?", resultado.detalle)

    def test_sin_direccion_https_no_se_comprueba(self):
        for url in (None, "", "http://revision.local"):
            self.assertEqual(monitor.comprobar_salud_publica(url, AHORA).estado, OMITIDO, url)


class CanalesTests(unittest.TestCase):
    def test_sin_canales_es_una_advertencia_y_con_uno_mal_puesto_una_falla(self):
        self.assertEqual(monitor.comprobar_canales({}).estado, ADVERTENCIA)
        self.assertEqual(monitor.comprobar_canales({"DATOS_AVISOS_SLACK_URL": "https://hooks.slack.com/services/T/B/x"}), Resultado("canales de aviso", OK, "slack"))
        mal = monitor.comprobar_canales({"DATOS_AVISOS_SLACK_URL": "http://hooks.slack.com/services/T/B/secreto"})
        self.assertEqual(mal.estado, FALLA)
        self.assertNotIn("secreto", mal.detalle)


class TareasTests(ConServidores):
    def setUp(self):
        self.dir = self.carpeta()

    def estado(self, nombre, horas, codigo=0, fallas=0):
        fin = (AHORA - timedelta(hours=horas)).isoformat(timespec="seconds")
        tarea.ruta_estado(self.dir, nombre).write_text(json.dumps({"tarea": nombre, "fin": fin, "codigo": codigo, "fallas_seguidas": fallas}))

    def por_nombre(self):
        return {r.nombre: r for r in monitor.comprobar_tareas(self.dir, AHORA)}

    def test_las_tareas_al_dia_estan_bien_y_el_analista_que_no_corrio_no_importa(self):
        for nombre in ("ejecutar", "avisar", "respaldar"):
            self.estado(nombre, 1)
        resultados = self.por_nombre()
        self.assertEqual(sorted(resultados), ["tarea avisar", "tarea ejecutar", "tarea respaldar"])
        self.assertTrue(all(r.estado == OK for r in resultados.values()))
        self.assertEqual(resultados["tarea avisar"].detalle, "corrió bien hace 1 h")

    def test_una_tarea_esperada_que_dejo_de_correr_es_una_falla_y_el_analista_una_advertencia(self):
        self.estado("avisar", 6)
        self.estado("agente", 3)
        resultados = self.por_nombre()
        self.assertEqual(resultados["tarea avisar"].estado, FALLA)
        self.assertIn("no corre desde hace 6 h (corre cada menos de 5 h)", resultados["tarea avisar"].detalle)
        self.assertEqual(resultados["tarea agente"].estado, ADVERTENCIA)

    def test_cada_tarea_tiene_su_ritmo(self):
        self.estado("ejecutar", 17)  # de 17:30 a 9:30 son 16 h: 17 todavía está bien
        self.estado("respaldar", 25)
        self.assertEqual({r.estado for r in self.por_nombre().values() if r.nombre != "tarea avisar"}, {OK})
        self.estado("respaldar", 27)
        self.assertEqual(self.por_nombre()["tarea respaldar"].estado, FALLA)

    def test_una_esperada_que_no_corrio_nunca_es_una_advertencia(self):
        resultado = self.por_nombre()["tarea respaldar"]
        self.assertEqual(resultado.estado, ADVERTENCIA)
        self.assertIn("no corrió nunca", resultado.detalle)

    def test_venir_fallando_es_una_falla_y_una_falla_suelta_una_advertencia(self):
        self.estado("ejecutar", 1, codigo=1, fallas=3)
        self.estado("avisar", 1, codigo=1, fallas=1)
        resultados = self.por_nombre()
        self.assertEqual(resultados["tarea ejecutar"].estado, FALLA)
        self.assertIn("falló las últimas 3 veces", resultados["tarea ejecutar"].detalle)
        self.assertEqual(resultados["tarea avisar"].estado, ADVERTENCIA)

    def test_un_estado_ilegible_es_una_advertencia(self):
        tarea.ruta_estado(self.dir, "avisar").write_text("{roto")
        self.assertIn("no se puede leer", self.por_nombre()["tarea avisar"].detalle)

    def test_lee_lo_que_deja_el_lanzador_de_verdad(self):
        with contextlib.redirect_stdout(io.StringIO()):
            tarea.ejecutar_tarea("avisar", (sys.executable, "-c", "pass"), carpeta_bloqueos=self.dir)
        self.assertEqual(self.por_nombre()["tarea avisar"].estado, OK)


class DiscosTests(ConServidores):
    def test_con_espacio_esta_bien_y_sin_el_disco_de_respaldo_falla(self):
        crudo = self.carpeta()
        resultados = monitor.comprobar_discos({"crudo": crudo, "respaldo": crudo / "no-montado", "otro": None})
        self.assertEqual([(r.nombre, r.estado) for r in resultados], [("disco del crudo", OK), ("disco del respaldo", FALLA)])
        self.assertIn("¿está montado el disco?", resultados[1].detalle)

    def test_poco_espacio(self):
        carpeta = self.carpeta()
        for libre, estado in ((500 * 2**20, FALLA), (3 * 2**30, ADVERTENCIA), (50 * 2**30, OK)):
            (resultado,) = monitor.comprobar_discos({"crudo": carpeta}, disco=lambda _ruta, libre=libre: SimpleNamespace(free=libre))
            self.assertEqual(resultado.estado, estado, libre)


class ResumenTests(unittest.TestCase):
    def test_primero_lo_que_falla_y_un_titulo_que_lo_dice(self):
        sano, texto = monitor.resumen([Resultado("a", OK, "bien"), Resultado("b", OMITIDO, "no"), Resultado("c", FALLA, "mal"), Resultado("d", ADVERTENCIA, "ojo"),
                                       Resultado("e", FALLA, "peor")])
        self.assertFalse(sano)
        self.assertEqual(texto.splitlines(), ["ChartBay datos: 2 problemas", "✗ c: mal", "✗ e: peor", "! d: ojo", "✓ a: bien", "· b: no"])

    def test_sin_fallas_esta_sano_aunque_haya_advertencias(self):
        self.assertEqual(monitor.resumen([Resultado("a", OK, "bien")]), (True, "ChartBay datos: todo bien\n✓ a: bien"))
        sano, texto = monitor.resumen([Resultado("a", ADVERTENCIA, "ojo")])
        self.assertEqual((sano, texto.splitlines()[0]), (True, "ChartBay datos: todo bien, con 1 advertencia"))


class ComprobarTodoTests(ConServidores):
    def test_una_comprobacion_que_se_rompe_es_una_falla_y_las_demas_siguen(self):
        conf = monitor.configuracion_desde_entorno({"DATOS_RUN_DIR": str(self.carpeta()), "DATOS_MONITOR_SALUD_LOCAL": "http://127.0.0.1:1/salud"})
        with patch.object(monitor, "comprobar_canales", side_effect=RuntimeError("inesperado")):
            resultados = {r.nombre: r for r in monitor.comprobar(conf, AHORA)}
        self.assertEqual(resultados["canales de aviso"], Resultado("canales de aviso", FALLA, "la comprobación se rompió (RuntimeError: inesperado)"))
        self.assertIn("tarea avisar", resultados)  # las demás corrieron igual
        self.assertEqual(resultados["revisión local"].estado, FALLA)


class MonitorTests(ConServidores):
    def monitor(self, servidor, **kwargs):
        return monitor.Monitor(servidor.url + "/ping/abc-123", esquemas=("http",), pausa=0, **kwargs)

    def test_late_bien_o_con_falla_y_manda_el_detalle(self):
        servidor = self.servidor({"/ping/abc-123": (200, "OK"), "/ping/abc-123/fail": (200, "OK")})
        self.monitor(servidor).latir("todo bien")
        self.monitor(servidor).latir("✗ base: no responde", falla=True)
        self.assertEqual(servidor.pedidos, [("POST", "/ping/abc-123", "todo bien"), ("POST", "/ping/abc-123/fail", "✗ base: no responde")])

    def test_reintenta_si_el_monitor_falla_y_no_si_la_direccion_esta_mal(self):
        servidor = self.servidor({"/ping/abc-123": [(503, "ocupado"), (200, "OK")]})
        self.monitor(servidor).latir("x")
        self.assertEqual(len(servidor.pedidos), 2)
        perdido = self.servidor({})
        with self.assertRaises(ErrorLatido) as contexto:
            self.monitor(perdido).latir("x")
        self.assertEqual((str(contexto.exception), len(perdido.pedidos)), ("el monitor respondió HTTP 404", 1))
        self.assertNotIn("abc-123", str(contexto.exception))  # la dirección es una credencial

    def test_no_sigue_redirecciones(self):
        otro = self.servidor({"/robar": (200, "OK")})
        servidor = self.servidor({"/ping/abc-123": (302, "", {"Location": otro.url + "/robar"})})
        with self.assertRaisesRegex(ErrorLatido, "HTTP 302"):
            self.monitor(servidor).latir("x")
        self.assertEqual(otro.pedidos, [])

    def test_si_no_hay_red_lo_dice_sin_la_direccion(self):
        with self.assertRaises(ErrorLatido) as contexto:
            monitor.Monitor("http://127.0.0.1:1/ping/abc-123", esquemas=("http",), pausa=0).latir("x")
        self.assertIn("no se pudo hablar con el monitor", str(contexto.exception))
        self.assertNotIn("abc-123", str(contexto.exception))

    def test_solo_https_y_el_cuerpo_tiene_tope(self):
        for url in ("http://hc-ping.com/abc", "ftp://hc-ping.com/abc", "https:///abc", "hc-ping.com/abc"):
            with self.assertRaises(ValueError, msg=url):
                monitor.Monitor(url)
        monitor.Monitor("https://hc-ping.com/abc")
        servidor = self.servidor({"/ping/abc-123": (200, "OK")})
        self.monitor(servidor).latir("x" * 50_000)
        self.assertEqual(len(servidor.pedidos[0][2]), monitor.MAX_CUERPO)


class ConBase(BaseEsquema):
    def setUp(self):
        super().setUp()
        self.url = f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"

    def aviso(self, clave, estado, intentos):
        self.conn.execute("INSERT INTO aviso (clave, tipo, referencia, asunto, cuerpo, estado, intentos) VALUES (%s, 'sin_datos', 'x', 'a', 'c', %s, %s)",
                          (clave, estado, intentos))


class BaseYAvisosTests(ConBase):
    def test_la_base_responde_y_los_avisos_salen(self):
        self.aviso("a", "enviado", 1)
        self.aviso("b", "pendiente", 1)  # el primer intento puede fallar sin que sea un problema
        self.assertEqual([(r.nombre, r.estado) for r in monitor.comprobar_base(self.url)], [("base", OK), ("avisos entregados", OK)])

    def test_avisos_perdidos_o_trabados_son_una_falla(self):
        for clave, estado, intentos in (("a", "fallido", 5), ("b", "pendiente", 2)):
            self.aviso(clave, estado, intentos)
        avisos = monitor.comprobar_base(self.url)[1]
        self.assertEqual(avisos.estado, FALLA)
        self.assertIn("1 avisos se dieron por perdidos en la última semana y 1 siguen sin poder entregarse", avisos.detalle)

    def test_una_base_que_no_responde_es_una_falla_sin_la_clave(self):
        (resultado,) = monitor.comprobar_base("postgresql://datos_escritura:clave-secreta@127.0.0.1:1/postgres?connect_timeout=2")
        self.assertEqual(resultado.estado, FALLA)
        self.assertNotIn("clave-secreta", resultado.detalle)
        self.assertEqual(monitor.comprobar_base(None)[0].detalle, "falta DATOS_DATABASE_URL")


class LineaDeComandosTests(ConBase, ConServidores):
    def setUp(self):
        super().setUp()
        self.salud = self.servidor({"/salud": (200, "ok")})
        self.monitor_externo = self.servidor({"/ping/abc": (200, "OK"), "/ping/abc/fail": (200, "OK")})
        self.tareas, self.crudo = self.carpeta(), self.carpeta()
        for nombre in ("ejecutar", "avisar", "respaldar"):
            # La hora de ahora y no la de cuando se importó el módulo: el latido compara con el reloj real.
            fin = (datetime.now(timezone.utc) - timedelta(minutes=30)).isoformat(timespec="seconds")
            tarea.ruta_estado(self.tareas, nombre).write_text(json.dumps({"tarea": nombre, "fin": fin, "codigo": 0, "fallas_seguidas": 0}))

    def entorno(self, **cambios):
        entorno = {"DATOS_MONITOR_URL": self.monitor_externo.url + "/ping/abc", "DATOS_MONITOR_SALUD_LOCAL": self.salud.url + "/salud",
                   "DATOS_DATABASE_URL": self.url, "DATOS_RUN_DIR": str(self.tareas), "DATOS_CRUDO_DIR": str(self.crudo), "DATOS_RESPALDO_DIR": str(self.crudo),
                   "DATOS_AVISOS_SLACK_URL": "https://hooks.slack.com/services/T/B/x", **cambios}
        return {k: v for k, v in entorno.items() if v is not None}

    def cli(self, *args, entorno=None):
        salida, errores = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, entorno if entorno is not None else self.entorno(), clear=True), \
                patch.object(monitor, "Monitor", partial(monitor.Monitor, esquemas=("http",), pausa=0)), \
                contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            codigo = latido.main(list(args))
        return codigo, salida.getvalue(), errores.getvalue()

    def test_con_todo_bien_late_y_deja_una_sola_linea(self):
        codigo, salida, _ = self.cli()
        self.assertEqual((codigo, salida.strip()), (0, "ChartBay datos: todo bien"))
        ((metodo, ruta, cuerpo),) = self.monitor_externo.pedidos
        self.assertEqual((metodo, ruta), ("POST", "/ping/abc"))
        self.assertIn("✓ base: responde", cuerpo)
        self.assertIn("✓ tarea respaldar: corrió bien hace 30 min", cuerpo)

    def test_si_algo_falla_late_con_falla_y_el_detalle(self):
        self.salud.respuestas["/salud"] = (500, "error")
        codigo, salida, _ = self.cli()
        self.assertEqual(codigo, 1)
        ((_, ruta, cuerpo),) = self.monitor_externo.pedidos
        self.assertEqual(ruta, "/ping/abc/fail")
        self.assertTrue(cuerpo.startswith("ChartBay datos: 1 problema\n✗ revisión local: /salud respondió HTTP 500"))
        self.assertIn("✗ revisión local", salida)

    def test_estado_muestra_sin_latir_y_no_necesita_el_monitor(self):
        codigo, salida, _ = self.cli("estado", entorno=self.entorno(DATOS_MONITOR_URL=None))
        self.assertEqual(codigo, 0)
        self.assertIn("✓ revisión local: responde", salida)
        self.assertIn("· revisión pública: sin dirección HTTPS", salida)
        self.assertEqual(self.monitor_externo.pedidos, [])

    def test_probar_manda_un_latido_de_prueba(self):
        codigo, salida, _ = self.cli("probar")
        self.assertEqual((codigo, salida.strip()), (0, "El monitor recibió el latido de prueba."))
        self.assertIn("latido de prueba", self.monitor_externo.pedidos[0][2])

    def test_sin_monitor_configurado_no_late(self):
        codigo, _, errores = self.cli(entorno=self.entorno(DATOS_MONITOR_URL=None))
        self.assertEqual(codigo, 1)
        self.assertIn("falta DATOS_MONITOR_URL", errores)

    def test_si_no_puede_latir_lo_dice_y_avisa_que_el_monitor_lo_va_a_notar(self):
        codigo, salida, errores = self.cli(entorno=self.entorno(DATOS_MONITOR_URL="http://127.0.0.1:1/ping/abc"))
        self.assertEqual(codigo, 1)
        self.assertIn("el monitor va a avisar que el equipo no responde", errores)
        self.assertIn("ChartBay datos: todo bien", salida)
        self.assertNotIn("/ping/abc", errores)


if __name__ == "__main__":
    unittest.main()
