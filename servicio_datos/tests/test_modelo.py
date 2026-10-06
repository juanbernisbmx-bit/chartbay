"""Cliente del modelo local contra un servidor falso que habla la API de chat de OpenAI. No necesita Postgres ni un modelo real."""
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from servicio_datos.agente.modelo import ErrorModelo, ModeloLocal, extraer_json, modelo_desde_entorno


class ServidorFalso:
    """Un servidor de chat local: guarda cada pedido y responde lo que se le diga, en orden."""

    def __init__(self):
        self.pedidos, self.respuestas, self.demora, self.redirige_a = [], [], 0, None
        yo = self

        class Manejador(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                cuerpo = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                yo.pedidos.append({"ruta": self.path, "cuerpo": cuerpo, "cabeceras": dict(self.headers)})
                time.sleep(yo.demora)
                if yo.redirige_a:
                    self.send_response(302)
                    self.send_header("Location", yo.redirige_a)
                    self.end_headers()
                    return
                estado, texto = yo.respuestas.pop(0) if len(yo.respuestas) > 1 else yo.respuestas[0]
                self.send_response(estado)
                self.send_header("Content-Length", str(len(texto.encode())))
                self.end_headers()
                self.wfile.write(texto.encode())

        self.servidor = ThreadingHTTPServer(("127.0.0.1", 0), Manejador)
        self.url = f"http://127.0.0.1:{self.servidor.server_port}/v1"
        threading.Thread(target=self.servidor.serve_forever, daemon=True).start()

    def responde(self, *contenidos):
        """Cada contenido es el texto del mensaje del modelo; un (estado, cuerpo) es una respuesta HTTP cruda."""
        self.respuestas = [c if isinstance(c, tuple) else (200, json.dumps({"choices": [{"message": {"role": "assistant", "content": c}}]})) for c in contenidos]
        return self

    def cerrar(self):
        self.servidor.shutdown()
        self.servidor.server_close()


MENSAJES = [{"role": "system", "content": "Sos un analista."}, {"role": "user", "content": '{"hallazgo": 1}'}]


class ConsultaTests(unittest.TestCase):
    def setUp(self):
        self.servidor = ServidorFalso()
        self.addCleanup(self.servidor.cerrar)

    def modelo(self, **kwargs):
        return ModeloLocal("qwen2.5:7b", self.servidor.url, **kwargs)

    def test_manda_el_pedido_como_lo_espera_un_servidor_compatible_con_openai(self):
        self.servidor.responde('{"ok": true}')
        self.modelo(max_tokens=321).consultar_json(MENSAJES)
        pedido = self.servidor.pedidos[0]
        self.assertEqual(pedido["ruta"], "/v1/chat/completions")
        self.assertEqual(pedido["cuerpo"], {"model": "qwen2.5:7b", "messages": MENSAJES, "temperature": 0, "stream": False, "max_tokens": 321,
                                            "response_format": {"type": "json_object"}})
        self.assertEqual(pedido["cabeceras"]["Content-Type"], "application/json")
        self.assertNotIn("Authorization", pedido["cabeceras"])  # un modelo local no necesita claves: no hay nada que filtrar

    def test_devuelve_el_objeto_aunque_el_modelo_lo_rodee_de_texto(self):
        casos = ('{"clasificacion": "dato_real"}',
                 'Claro, acá va:\n```json\n{"clasificacion": "dato_real"}\n```\nEspero que sirva.',
                 '<think>Veamos... {"borrador": 1} no, mejor otra cosa</think>{"clasificacion": "dato_real"}',
                 'Primero pienso {así} y después respondo: {"clasificacion": "dato_real"} y listo',
                 '{"clasificacion": "dato_real"} {"otro": "objeto"}')
        for caso in casos:
            self.servidor.responde(caso)
            self.assertEqual(self.modelo().consultar_json(MENSAJES), {"clasificacion": "dato_real"}, caso)

    def test_conserva_los_objetos_anidados_y_las_tildes(self):
        self.servidor.responde('{"a": {"b": [1, {"c": "índice"}]}, "razonamiento": "subió 25,5% — es real"}')
        self.assertEqual(self.modelo().consultar_json(MENSAJES)["a"]["b"][1]["c"], "índice")

    def test_si_el_servidor_no_acepta_response_format_reintenta_sin_el(self):
        self.servidor.responde((400, '{"error": "response_format no soportado"}'), '{"ok": true}')
        self.assertEqual(self.modelo().consultar_json(MENSAJES), {"ok": True})
        self.assertIn("response_format", self.servidor.pedidos[0]["cuerpo"])
        self.assertNotIn("response_format", self.servidor.pedidos[1]["cuerpo"])

    def test_lo_que_no_se_puede_usar_falla_con_un_error_claro_y_sin_filtrar_nada(self):
        casos = {
            "sin JSON": ("Lo siento, no puedo ayudar con eso.", "no contiene un objeto JSON"),
            "vacío": ("   ", "respondió vacío"),
            "JSON que no es un objeto": ("[1, 2, 3]", "no contiene un objeto JSON"),
            "pensamiento sin cerrar": ('<think>sigo pensando {"a": 1}', "no contiene un objeto JSON"),
            "formato raro": ((200, '{"sin": "choices"}'), "formato que no se entiende"),
            "cuerpo que no es JSON": ((200, "<html>proxy</html>"), "formato que no se entiende"),
            "HTTP 500": ((500, "stacktrace con /home/usuario/secreto"), "HTTP 500"),
            "HTTP 404": ((404, "modelo qwen-inexistente no encontrado"), "HTTP 404"),
        }
        for nombre, (respuesta, esperado) in casos.items():
            self.servidor.responde(respuesta)
            with self.assertRaises(ErrorModelo, msg=nombre) as contexto:
                self.modelo().consultar_json(MENSAJES)
            self.assertIn(esperado, str(contexto.exception), nombre)
            for filtrado in ("127.0.0.1", "secreto", "stacktrace", "qwen-inexistente"):
                self.assertNotIn(filtrado, str(contexto.exception), nombre)

    def test_un_servidor_lento_o_caido_se_informa_sin_la_direccion(self):
        self.servidor.responde('{"ok": true}').demora = 3
        with self.assertRaises(ErrorModelo) as contexto:
            self.modelo(timeout=0.5).consultar_json(MENSAJES)
        self.assertIn("No se pudo hablar con el servidor del modelo", str(contexto.exception))
        caido = ModeloLocal("m", "http://127.0.0.1:1/v1", timeout=2)
        with self.assertRaises(ErrorModelo) as contexto:
            caido.consultar_json(MENSAJES)
        self.assertNotIn("127.0.0.1", str(contexto.exception))

    def test_no_sigue_redirecciones(self):
        self.servidor.redirige_a = "http://otro-equipo.example/v1/chat/completions"
        with self.assertRaisesRegex(ErrorModelo, "redirección"):
            self.modelo().consultar_json(MENSAJES)

    def test_probar_mide_cuanto_tarda_y_falla_si_no_responde_json(self):
        self.servidor.responde('{"ok": true}')
        self.assertGreaterEqual(self.modelo().probar(), 0)
        self.servidor.responde("no hay JSON")
        with self.assertRaises(ErrorModelo):
            self.modelo().probar()


class ExtraerJsonTests(unittest.TestCase):
    def test_ignora_llaves_sueltas_y_bloques_de_pensamiento_con_llaves(self):
        self.assertEqual(extraer_json('{ no es json } <think>{"x": 1}</think> {"y": 2}'), {"y": 2})

    def test_mayusculas_en_las_etiquetas_y_vallas_sin_lenguaje(self):
        self.assertEqual(extraer_json('<THINK>cosas</THINK>\n```\n{"y": 2}\n```'), {"y": 2})


class SoloLocalTests(unittest.TestCase):
    def test_solo_acepta_la_propia_maquina(self):
        for url in ("http://127.0.0.1:11434/v1", "http://localhost:8080/v1", "http://[::1]:11434/v1", "https://localhost/v1"):
            ModeloLocal("m", url)
        for url in ("http://example.com/v1", "http://192.168.1.50:11434/v1", "http://0.0.0.0:11434/v1", "http://127.0.0.1.evil.example/v1",
                    "http://evil.example@127.0.0.1.evil.example/v1", "http://10.0.0.5/v1", "file:///etc/passwd", "ftp://localhost/v1", "localhost:11434"):
            with self.assertRaisesRegex(ValueError, "esta computadora", msg=url):
                ModeloLocal("m", url)

    def test_exige_el_nombre_del_modelo(self):
        for nombre in ("", "   "):
            with self.assertRaises(ValueError):
                ModeloLocal(nombre)


class ConfiguracionTests(unittest.TestCase):
    def test_sin_modelo_el_analisis_con_modelo_queda_apagado(self):
        for env in ({}, {"DATOS_AGENTE_MODELO": ""}, {"DATOS_AGENTE_MODELO": "  "}, {"DATOS_AGENTE_URL": "http://127.0.0.1:1/v1"}):
            self.assertIsNone(modelo_desde_entorno(env))

    def test_con_modelo_usa_ollama_por_defecto_y_se_puede_cambiar(self):
        por_defecto = modelo_desde_entorno({"DATOS_AGENTE_MODELO": "qwen2.5:7b"})
        self.assertEqual((por_defecto.nombre, por_defecto._url, por_defecto._timeout), ("qwen2.5:7b", "http://127.0.0.1:11434/v1/chat/completions", 180))
        propio = modelo_desde_entorno({"DATOS_AGENTE_MODELO": "llama3", "DATOS_AGENTE_URL": "http://localhost:8080/v1/", "DATOS_AGENTE_TIMEOUT": "600"})
        self.assertEqual((propio._url, propio._timeout), ("http://localhost:8080/v1/chat/completions", 600))

    def test_una_configuracion_invalida_se_rechaza(self):
        for env in ({"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_TIMEOUT": "abc"}, {"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_TIMEOUT": "2"},
                    {"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_TIMEOUT": "99999"}, {"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_URL": "http://example.com/v1"}):
            with self.assertRaises(ValueError, msg=str(env)):
                modelo_desde_entorno(env)


if __name__ == "__main__":
    unittest.main()
