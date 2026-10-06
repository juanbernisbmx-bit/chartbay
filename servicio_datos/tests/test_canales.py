"""Canales de aviso contra un Slack y un servidor de correo falsos y locales: no sale nada a internet."""
import base64
import email
import json
import socketserver
import threading
import unittest
from email import policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from servicio_datos.canales import (CanalEmail, CanalSlack, ErrorEnvio, Mensaje, configuracion_desde_entorno, escapar_slack)

SECRETO = "SECRETTOKEN123"
RUTA_SLACK = f"/services/T000/B000/{SECRETO}"


class SlackFalso:
    """Un webhook local: guarda lo que le llega y responde lo que se le diga."""

    def __init__(self):
        self.recibidos, self.estado, self.redirige_a = [], 200, None
        yo = self

        class Manejador(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                cuerpo = self.rfile.read(int(self.headers["Content-Length"]))
                yo.recibidos.append((self.path, json.loads(cuerpo), self.headers.get("Content-Type")))
                if yo.redirige_a:
                    self.send_response(302)
                    self.send_header("Location", yo.redirige_a)
                    self.end_headers()
                    return
                self.send_response(yo.estado)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")

        self.servidor = ThreadingHTTPServer(("127.0.0.1", 0), Manejador)
        self.url = f"http://127.0.0.1:{self.servidor.server_port}{RUTA_SLACK}"
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()

    def cerrar(self):
        self.servidor.shutdown()
        self.servidor.server_close()

    def canal(self, **kwargs):
        return CanalSlack(self.url, hosts=("127.0.0.1",), esquemas=("http",), **kwargs)


class SmtpFalso:
    """Un servidor SMTP mínimo y local: guarda los mensajes y las credenciales que recibe."""

    def __init__(self, exige_login=False, clave_valida="clave-correcta"):
        self.mensajes, self.credenciales = [], []
        yo = self

        class Manejador(socketserver.StreamRequestHandler):
            def responder(self, texto):
                self.wfile.write(texto.encode() + b"\r\n")

            def handle(self):
                self.responder("220 smtp-falso listo")
                remitente, destinatarios = None, []
                while True:
                    linea = self.rfile.readline().decode(errors="replace").rstrip("\r\n")
                    if not linea:
                        return
                    comando = linea.split(" ", 1)[0].upper()
                    if comando == "EHLO":
                        self.responder("250-smtp-falso")
                        self.responder("250-AUTH PLAIN" if exige_login else "250-SIZE 100000")
                        self.responder("250 8BITMIME")
                    elif comando == "AUTH":
                        _, usuario, clave = base64.b64decode(linea.split(" ")[2]).decode().split("\0")
                        yo.credenciales.append((usuario, clave))
                        self.responder("235 autenticado" if clave == clave_valida else "535 credenciales rechazadas")
                    elif comando == "MAIL":
                        remitente, destinatarios = linea, []
                        self.responder("250 ok")
                    elif comando == "RCPT":
                        destinatarios.append(linea.split(":", 1)[1].strip(" <>"))
                        self.responder("250 ok")
                    elif comando == "DATA":
                        self.responder("354 adelante")
                        datos = b""
                        while True:
                            renglon = self.rfile.readline()
                            if renglon in (b".\r\n", b""):
                                break
                            datos += renglon
                        yo.mensajes.append((destinatarios, email.message_from_bytes(datos, policy=policy.default)))
                        self.responder("250 en cola")
                    elif comando == "QUIT":
                        self.responder("221 chau")
                        return
                    else:
                        self.responder("250 ok")

        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self.servidor = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Manejador)
        self.puerto = self.servidor.server_address[1]
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()

    def cerrar(self):
        self.servidor.shutdown()
        self.servidor.server_close()


class SlackTests(unittest.TestCase):
    def setUp(self):
        self.slack = SlackFalso()
        self.addCleanup(self.slack.cerrar)

    def test_manda_el_asunto_el_cuerpo_y_el_enlace_como_json(self):
        self.slack.canal().enviar(Mensaje("Candidato 3 para revisar", "Hay 4 hallazgos.", "https://datos.example/candidatos/3"))
        ruta, cuerpo, tipo = self.slack.recibidos[0]
        self.assertEqual((ruta, tipo), (RUTA_SLACK, "application/json"))
        self.assertEqual(cuerpo["text"], "*Candidato 3 para revisar*\nHay 4 hallazgos.\n<https://datos.example/candidatos/3|Abrir en la interfaz de revisión>")

    def test_sin_enlace_no_pone_uno(self):
        self.slack.canal().enviar(Mensaje("Aviso", "Texto"))
        self.assertNotIn("<http", self.slack.recibidos[0][1]["text"])

    def test_lo_que_viene_de_la_base_no_puede_armar_menciones_ni_enlaces(self):
        self.slack.canal().enviar(Mensaje("<!channel> urgente", "Falló: <!here> <https://malo.example|clic> & más"))
        texto = self.slack.recibidos[0][1]["text"]
        self.assertNotIn("<!channel>", texto)
        self.assertNotIn("<!here>", texto)
        self.assertNotIn("<https://malo.example", texto)
        self.assertIn("&lt;!channel&gt; urgente", texto)
        self.assertEqual(escapar_slack("a & <b>"), "a &amp; &lt;b&gt;")

    def test_un_texto_larguisimo_se_corta(self):
        self.slack.canal().enviar(Mensaje("A", "x" * 10_000))
        self.assertLessEqual(len(self.slack.recibidos[0][1]["text"]), 3500)

    def test_un_error_http_se_informa_sin_la_url(self):
        self.slack.estado = 500
        with self.assertRaises(ErrorEnvio) as contexto:
            self.slack.canal().enviar(Mensaje("A", "B"))
        self.assertEqual(str(contexto.exception), "Slack respondió HTTP 500")
        self.assertNotIn(SECRETO, str(contexto.exception))

    def test_una_conexion_caida_se_informa_sin_la_url(self):
        canal = CanalSlack(f"http://127.0.0.1:1{RUTA_SLACK}", hosts=("127.0.0.1",), esquemas=("http",), timeout=2)
        with self.assertRaises(ErrorEnvio) as contexto:
            canal.enviar(Mensaje("A", "B"))
        self.assertNotIn(SECRETO, str(contexto.exception))
        self.assertNotIn("127.0.0.1", str(contexto.exception))
        self.assertIn("No se pudo conectar con Slack", str(contexto.exception))

    def test_no_sigue_redirecciones(self):
        self.slack.redirige_a = "https://otro-sitio.example/robo"
        with self.assertRaises(ErrorEnvio) as contexto:
            self.slack.canal().enviar(Mensaje("A", "B"))
        self.assertIn("redirección", str(contexto.exception))
        self.assertNotIn("otro-sitio", str(contexto.exception))

    def test_solo_acepta_el_webhook_de_slack_por_https_y_no_repite_la_url_en_el_error(self):
        for url in (f"http://hooks.slack.com{RUTA_SLACK}", f"https://otro.example{RUTA_SLACK}", "ftp://hooks.slack.com/x", "no-es-una-url"):
            with self.assertRaises(ValueError) as contexto:
                CanalSlack(url)
            self.assertNotIn(SECRETO, str(contexto.exception))
        CanalSlack(f"https://hooks.slack.com{RUTA_SLACK}")  # el válido no falla


class EmailTests(unittest.TestCase):
    def setUp(self):
        self.smtp = SmtpFalso()
        self.addCleanup(self.smtp.cerrar)

    def canal(self, **kwargs):
        datos = dict(host="127.0.0.1", puerto=self.smtp.puerto, de="datos@example.com", para=["juani@example.com", "ana@example.com"], seguridad="ninguna")
        return CanalEmail(**{**datos, **kwargs})

    def test_manda_el_correo_con_asunto_destinatarios_cuerpo_y_enlace(self):
        self.canal().enviar(Mensaje("Candidato 3 para revisar", "Hay 4 hallazgos.", "https://datos.example/candidatos/3"))
        destinatarios, correo = self.smtp.mensajes[0]
        self.assertEqual(destinatarios, ["juani@example.com", "ana@example.com"])
        self.assertEqual((correo["Subject"], correo["From"]), ("Candidato 3 para revisar", "datos@example.com"))
        texto = correo.get_content()
        self.assertIn("Hay 4 hallazgos.", texto)
        self.assertIn("https://datos.example/candidatos/3", texto)

    def test_el_asunto_no_puede_inyectar_cabeceras(self):
        self.canal().enviar(Mensaje("Hola\r\nBcc: intruso@example.com\r\nX-Otra: 1", "Cuerpo"))
        destinatarios, correo = self.smtp.mensajes[0]
        self.assertEqual(destinatarios, ["juani@example.com", "ana@example.com"])
        self.assertIsNone(correo["Bcc"])
        self.assertIsNone(correo["X-Otra"])
        self.assertEqual(correo["Subject"], "Hola Bcc: intruso@example.com X-Otra: 1")

    def test_los_acentos_viajan_bien(self):
        self.canal().enviar(Mensaje("Falló la corrida", "Índices aperturas: no se pudo leer"))
        _, correo = self.smtp.mensajes[0]
        self.assertEqual(correo["Subject"], "Falló la corrida")
        self.assertIn("Índices aperturas", correo.get_content())

    def test_inicia_sesion_cuando_hay_usuario(self):
        servidor = SmtpFalso(exige_login=True)
        self.addCleanup(servidor.cerrar)
        CanalEmail("127.0.0.1", servidor.puerto, "datos@example.com", ["juani@example.com"], "usuario-smtp", "clave-correcta", "ninguna").enviar(Mensaje("A", "B"))
        self.assertEqual(servidor.credenciales, [("usuario-smtp", "clave-correcta")])
        self.assertEqual(len(servidor.mensajes), 1)

    def test_una_clave_mala_se_informa_sin_el_usuario_ni_la_clave(self):
        servidor = SmtpFalso(exige_login=True)
        self.addCleanup(servidor.cerrar)
        canal = CanalEmail("127.0.0.1", servidor.puerto, "datos@example.com", ["juani@example.com"], "usuario-smtp", "clave-equivocada", "ninguna")
        with self.assertRaises(ErrorEnvio) as contexto:
            canal.enviar(Mensaje("A", "B"))
        texto = str(contexto.exception)
        self.assertIn("SMTPAuthenticationError", texto)
        self.assertIn("535", texto)
        for secreto in ("usuario-smtp", "clave-equivocada", "rechazadas"):
            self.assertNotIn(secreto, texto)
        self.assertEqual(servidor.mensajes, [])

    def test_un_servidor_caido_se_informa_sin_datos_de_conexion(self):
        with self.assertRaises(ErrorEnvio) as contexto:
            self.canal(puerto=1, timeout=2).enviar(Mensaje("A", "B"))
        self.assertIn("No se pudo enviar el correo", str(contexto.exception))
        self.assertNotIn("127.0.0.1", str(contexto.exception))

    def test_configuracion_insegura_o_invalida_se_rechaza(self):
        with self.assertRaisesRegex(ValueError, "Sin cifrado solo se admite un servidor local"):
            CanalEmail("smtp.example.com", 25, "datos@example.com", ["juani@example.com"], seguridad="ninguna")
        with self.assertRaisesRegex(ValueError, "starttls, ssl o ninguna"):
            self.canal(seguridad="quizas")
        for mala in ("sin-arroba", "a@b.com\nBcc: x@y.com", "a@b.com, c@d.com", "<a@b.com>", "a b@c.com"):
            with self.assertRaises(ValueError, msg=mala):
                self.canal(para=[mala])
        with self.assertRaises(ValueError):
            self.canal(de="no es un correo")
        with self.assertRaisesRegex(ValueError, "destinatario"):
            self.canal(para=[])


class ConfiguracionTests(unittest.TestCase):
    def test_sin_nada_configurado_no_hay_canales(self):
        configuracion = configuracion_desde_entorno({})
        self.assertEqual((configuracion.canales, configuracion.url_base), ((), None))

    def test_con_slack_y_correo_arma_los_dos_y_limpia_la_direccion_de_la_interfaz(self):
        configuracion = configuracion_desde_entorno({
            "DATOS_AVISOS_SLACK_URL": f"https://hooks.slack.com{RUTA_SLACK}",
            "DATOS_AVISOS_SMTP_HOST": "smtp.example.com", "DATOS_AVISOS_SMTP_USUARIO": "u", "DATOS_AVISOS_SMTP_CLAVE": "c",
            "DATOS_AVISOS_DE": "datos@example.com", "DATOS_AVISOS_PARA": "juani@example.com, ana@example.com",
            "DATOS_REVISION_URL": "https://revision.example.com/"})
        self.assertEqual([c.nombre for c in configuracion.canales], ["slack", "email"])
        self.assertEqual(configuracion.url_base, "https://revision.example.com")

    def test_el_correo_exige_remitente_y_destinatarios(self):
        with self.assertRaises(ValueError):
            configuracion_desde_entorno({"DATOS_AVISOS_SMTP_HOST": "smtp.example.com"})

    def test_una_url_de_slack_mala_se_rechaza_sin_repetirla(self):
        with self.assertRaises(ValueError) as contexto:
            configuracion_desde_entorno({"DATOS_AVISOS_SLACK_URL": f"https://otro.example{RUTA_SLACK}"})
        self.assertNotIn(SECRETO, str(contexto.exception))

    def test_los_dias_del_primer_recordatorio_tienen_valor_por_defecto_y_se_validan(self):
        self.assertEqual(configuracion_desde_entorno({}).recordatorio_dias, 3)
        self.assertEqual(configuracion_desde_entorno({"DATOS_AVISOS_RECORDATORIO_DIAS": "0"}).recordatorio_dias, 0)
        self.assertEqual(configuracion_desde_entorno({"DATOS_AVISOS_RECORDATORIO_DIAS": " 7 "}).recordatorio_dias, 7)
        for malo in ("abc", "-1", "61", "2.5", ""):
            with self.assertRaises(ValueError, msg=malo):
                configuracion_desde_entorno({"DATOS_AVISOS_RECORDATORIO_DIAS": malo})

    def test_la_direccion_de_la_interfaz_tiene_que_ser_una_url(self):
        with self.assertRaises(ValueError):
            configuracion_desde_entorno({"DATOS_REVISION_URL": "javascript:alert(1)"})


if __name__ == "__main__":
    unittest.main()
