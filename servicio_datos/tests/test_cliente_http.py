"""Cliente HTTP contra un servidor local: reintentos, redirecciones y límites."""
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from servicio_datos.cliente_http import ClienteHttp, ErrorHttp


class Manejador(BaseHTTPRequestHandler):
    guion: dict = {}
    pedidos: list = []

    def log_message(self, *args):
        pass

    def do_GET(self):
        Manejador.pedidos.append(self.path)
        respuestas = Manejador.guion.get(self.path, [(404, {}, b"")])
        estado, cabeceras, cuerpo = respuestas.pop(0) if len(respuestas) > 1 else respuestas[0]
        self.send_response(estado)
        for nombre, valor in cabeceras.items():
            self.send_header(nombre, valor)
        self.send_header("Content-Length", str(len(cuerpo)))
        self.end_headers()
        self.wfile.write(cuerpo)


class ClienteHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.servidor = ThreadingHTTPServer(("127.0.0.1", 0), Manejador)
        cls.base = f"http://127.0.0.1:{cls.servidor.server_port}"
        threading.Thread(target=cls.servidor.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()
        cls.servidor.server_close()

    def setUp(self):
        Manejador.guion, Manejador.pedidos = {}, []
        self.esperas = []
        self.cliente = ClienteHttp(
            hosts=("127.0.0.1",), esquemas=("http",), timeout=5, reintentos=3, espera=1.0, dormir=self.esperas.append
        )

    def test_respuesta_con_fecha_de_publicacion(self):
        Manejador.guion["/a.xls"] = [(200, {"Content-Type": "application/vnd.ms-excel",
                                           "Last-Modified": "Thu, 10 Sep 2026 18:52:05 GMT"}, b"contenido")]
        respuesta = self.cliente.get(self.base + "/a.xls")
        self.assertEqual((respuesta.estado, respuesta.contenido), (200, b"contenido"))
        self.assertEqual(respuesta.tipo, "application/vnd.ms-excel")
        self.assertEqual(respuesta.last_modified.isoformat(), "2026-09-10T18:52:05+00:00")

    def test_fecha_ilegible_no_rompe(self):
        Manejador.guion["/a"] = [(200, {"Last-Modified": "mañana"}, b"x")]
        self.assertIsNone(self.cliente.get(self.base + "/a").last_modified)

    def test_404_vuelve_como_respuesta(self):
        respuesta = self.cliente.get(self.base + "/no-esta")
        self.assertEqual(respuesta.estado, 404)

    def test_reintenta_los_5xx_con_espera_creciente(self):
        Manejador.guion["/r"] = [(500, {}, b""), (503, {}, b""), (200, {}, b"ok")]
        self.assertEqual(self.cliente.get(self.base + "/r").contenido, b"ok")
        self.assertEqual(Manejador.pedidos, ["/r"] * 3)
        self.assertEqual(self.esperas, [1.0, 2.0])

    def test_se_rinde_tras_los_reintentos(self):
        Manejador.guion["/r"] = [(500, {}, b"")]
        with self.assertRaises(ErrorHttp) as contexto:
            self.cliente.get(self.base + "/r")
        self.assertIn("3 intentos", str(contexto.exception))
        self.assertEqual(len(Manejador.pedidos), 3)

    def test_un_4xx_no_se_reintenta(self):
        Manejador.guion["/p"] = [(403, {}, b"")]
        with self.assertRaises(ErrorHttp):
            self.cliente.get(self.base + "/p")
        self.assertEqual(len(Manejador.pedidos), 1)

    def test_rechaza_redirecciones_a_otro_host(self):
        Manejador.guion["/m"] = [(302, {"Location": "http://otro.invalid/robo"}, b"")]
        with self.assertRaises(ErrorHttp) as contexto:
            self.cliente.get(self.base + "/m")
        self.assertIn("Redirección rechazada", str(contexto.exception))

    def test_sigue_redirecciones_al_mismo_host(self):
        Manejador.guion["/viejo"] = [(301, {"Location": self.base + "/nuevo"}, b"")]
        Manejador.guion["/nuevo"] = [(200, {}, b"llego")]
        self.assertEqual(self.cliente.get(self.base + "/viejo").contenido, b"llego")

    def test_corta_las_respuestas_demasiado_grandes(self):
        Manejador.guion["/g"] = [(200, {}, b"x" * 100)]
        chico = ClienteHttp(hosts=("127.0.0.1",), esquemas=("http",), max_bytes=50, dormir=self.esperas.append)
        with self.assertRaises(ErrorHttp):
            chico.get(self.base + "/g")

    def test_no_sale_a_hosts_ni_esquemas_no_permitidos(self):
        estricto = ClienteHttp()
        for url in ("http://www.indec.gob.ar/x", "https://example.com/x", "file:///etc/passwd"):
            with self.assertRaises(ErrorHttp):
                estricto.get(url)


if __name__ == "__main__":
    unittest.main()
