"""Colector del IPC contra PostgreSQL, con un cliente HTTP falso.

El cliente imita a INDEC como es de verdad: los archivos que no existen
contestan 200 con una página HTML (verificado el 2026-10-06 con sh_ipc_10_26.xls).
"""
import shutil
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path

from servicio_datos import colector, repositorio
from servicio_datos.cliente_http import ErrorHttp, Respuesta
from servicio_datos.crudo import AlmacenCrudo
from servicio_datos.ipc import fuente
from servicio_datos.tests.base import BaseEsquema

HOY = date(2026, 10, 6)
BASE = fuente.URL_BASE
NAC = {m: f"{BASE}sh_ipc_{m}_26.xls" for m in ("08", "09", "10")}
APERTURAS = BASE + "sh_ipc_aperturas.xls"
PUBLICADA = datetime(2026, 9, 10, 18, 52, 5, tzinfo=timezone.utc)
HTML = Respuesta(200, b"<!DOCTYPE html>" + b" " * 40_000, "text/html; charset=utf-8", None)


def xls(semilla: str) -> Respuesta:
    contenido = colector.MAGIA_XLS + (semilla.encode() * 12_000)[:12_000]
    return Respuesta(200, contenido, "application/vnd.ms-excel", PUBLICADA)


class ClienteFalso:
    def __init__(self, respuestas):
        self.respuestas, self.pedidos = dict(respuestas), []

    def get(self, url):
        self.pedidos.append(url)
        respuesta = self.respuestas.get(url, HTML)
        if isinstance(respuesta, Exception):
            raise respuesta
        return respuesta


class BaseColector(BaseEsquema):
    def setUp(self):
        super().setUp()
        self.carpeta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.carpeta, ignore_errors=True)
        self.almacen = AlmacenCrudo(self.carpeta)

    def correr(self, respuestas, **kwargs):
        cliente = ClienteFalso(respuestas)
        self.cliente = cliente
        return colector.colectar(self.conn, self.almacen, cliente, HOY, **kwargs)

    def cerrar(self, resultado, estado="con_candidato"):
        """Lo que haría la etapa siguiente (parser y validación) al terminar."""
        repositorio.cerrar_corrida(self.conn, resultado.corrida_id, estado)

    def estados(self, resultado):
        return {d.clave: d.estado for d in resultado.descargas}

    def archivos_en_crudo(self):
        return len([p for p in self.carpeta.rglob("*") if p.is_file()])

    publicado = {NAC["09"]: xls("nacional-09"), APERTURAS: xls("aperturas-09")}


class PrimeraCorridaTests(BaseColector):
    def test_baja_lo_vigente_y_deja_la_corrida_en_curso(self):
        resultado = self.correr(self.publicado)
        self.assertEqual(resultado.estado, "nuevos_datos")
        self.assertEqual(self.estados(resultado), {"nacional": "nueva", "aperturas": "nueva"})
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (resultado.corrida_id,)), "en_curso")
        self.assertEqual(self.archivos_en_crudo(), 2)

    def test_prueba_el_mes_nuevo_primero_y_cae_al_anterior_si_no_esta_publicado(self):
        self.correr(self.publicado)
        self.assertEqual(self.cliente.pedidos, [NAC["10"], NAC["09"], APERTURAS])

    def test_registra_hash_tamano_ruta_y_fecha_de_publicacion(self):
        resultado = self.correr(self.publicado)
        nacional = next(d for d in resultado.descargas if d.clave == "nacional")
        fila = self.conn.execute(
            "SELECT sha256, bytes, ruta_crudo, publicada_en, estado FROM descarga WHERE id = %s", (nacional.id,)
        ).fetchone()
        self.assertEqual(fila[0], nacional.sha256)
        self.assertEqual(fila[1], len(self.publicado[NAC["09"]].contenido))
        self.assertEqual(self.almacen.ruta(fila[2]), nacional.ruta)
        self.assertEqual(nacional.ruta.read_bytes(), self.publicado[NAC["09"]].contenido)
        self.assertEqual(fila[3], PUBLICADA)
        self.assertEqual(fila[4], "nueva")

    def test_vincula_las_dos_descargas_a_la_corrida_y_resume(self):
        resultado = self.correr(self.publicado)
        self.assertEqual(
            self.uno("SELECT count(*) FROM corrida_descarga WHERE corrida_id = %s", (resultado.corrida_id,)), 2
        )
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (resultado.corrida_id,))
        self.assertEqual([a["clave"] for a in resumen["archivos"]], ["nacional", "aperturas"])
        self.assertTrue(all(a["estado"] == "nueva" for a in resumen["archivos"]))

    def test_crea_la_fuente_si_no_existe(self):
        self.conn.execute("DELETE FROM serie")
        self.conn.execute("DELETE FROM fuente")
        self.correr(self.publicado)
        self.assertEqual(self.uno("SELECT nombre FROM fuente WHERE id = 'INDEC_IPC'"), "INDEC")


class CorridasSiguientesTests(BaseColector):
    def test_sin_cambios_no_guarda_nada_nuevo_y_cierra_la_corrida(self):
        self.cerrar(self.correr(self.publicado))
        antes = self.archivos_en_crudo()
        resultado = self.correr(self.publicado)
        self.assertEqual(resultado.estado, "sin_cambios")
        self.assertEqual(self.estados(resultado), {"nacional": "identica", "aperturas": "identica"})
        self.assertEqual(self.archivos_en_crudo(), antes)
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (resultado.corrida_id,)), "sin_cambios")
        self.assertIsNotNone(self.uno("SELECT terminada_en FROM corrida WHERE id = %s", (resultado.corrida_id,)))
        # Cada corrida deja constancia de lo que vio, aunque no haya cambiado nada.
        self.assertEqual(self.uno("SELECT count(*) FROM descarga"), 4)

    def test_publicacion_nueva_de_un_solo_archivo_trae_a_los_dos(self):
        self.cerrar(self.correr(self.publicado))
        resultado = self.correr({**self.publicado, NAC["10"]: xls("nacional-10")})
        self.assertEqual(resultado.estado, "nuevos_datos")
        self.assertEqual(self.estados(resultado), {"nacional": "nueva", "aperturas": "identica"})
        nacional = next(d for d in resultado.descargas if d.clave == "nacional")
        self.assertEqual(nacional.url, NAC["10"])
        # La validación de cobertura necesita ver ambos archivos en la misma corrida.
        self.assertEqual(len(resultado.descargas), 2)

    def test_el_archivo_de_nombre_fijo_se_detecta_cuando_se_pisa(self):
        self.cerrar(self.correr(self.publicado))
        resultado = self.correr({**self.publicado, APERTURAS: xls("aperturas-10")})
        self.assertEqual(self.estados(resultado), {"nacional": "identica", "aperturas": "nueva"})

    def test_una_corrida_en_curso_bloquea_a_la_siguiente(self):
        primera = self.correr(self.publicado)
        segunda = self.correr(self.publicado)
        self.assertEqual((segunda.estado, segunda.corrida_id), ("ocupado", None))
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (primera.corrida_id,)), "en_curso")

    def test_una_corrida_abandonada_se_cierra_y_la_fuente_se_libera(self):
        primera = self.correr(self.publicado)
        self.conn.execute("UPDATE corrida SET iniciada_en = now() - interval '7 hours' WHERE id = %s", (primera.corrida_id,))
        segunda = self.correr(self.publicado)
        self.assertEqual(segunda.estado, "nuevos_datos")
        fila = self.conn.execute("SELECT estado, error FROM corrida WHERE id = %s", (primera.corrida_id,)).fetchone()
        self.assertEqual(fila[0], "fallida")
        self.assertIn("Abandonada", fila[1])
        # Nunca se dio por buena, así que el archivo vuelve a verse como nuevo.
        self.assertEqual(self.estados(segunda), {"nacional": "nueva", "aperturas": "nueva"})


class FallosTests(BaseColector):
    def test_error_de_red_en_un_archivo_cierra_la_corrida_como_fallida(self):
        resultado = self.correr({NAC["09"]: xls("n"), APERTURAS: ErrorHttp("No se pudo bajar tras 3 intentos")})
        self.assertEqual(resultado.estado, "fallida")
        self.assertIn("3 intentos", resultado.error)
        fila = self.conn.execute(
            "SELECT estado, error, terminada_en FROM corrida WHERE id = %s", (resultado.corrida_id,)
        ).fetchone()
        self.assertEqual(fila[0], "fallida")
        self.assertIn("3 intentos", fila[1])
        self.assertIsNotNone(fila[2])
        fallida = self.conn.execute(
            "SELECT url, sha256 FROM descarga WHERE estado = 'fallida'"
        ).fetchone()
        self.assertEqual(fallida, (APERTURAS, None))
        # Lo que sí se bajó antes del fallo queda registrado.
        self.assertEqual(self.estados(resultado), {"nacional": "nueva"})

    def test_lo_que_falla_se_reintenta_como_nuevo(self):
        self.correr({NAC["09"]: xls("n"), APERTURAS: ErrorHttp("caído")})
        resultado = self.correr(self.publicado | {NAC["09"]: xls("n")})
        self.assertEqual(resultado.estado, "nuevos_datos")
        self.assertEqual(self.estados(resultado)["nacional"], "nueva")

    def test_un_error_en_el_mes_nuevo_no_cae_en_silencio_al_anterior(self):
        resultado = self.correr({NAC["10"]: ErrorHttp("HTTP 500"), NAC["09"]: xls("n"), APERTURAS: xls("a")})
        self.assertEqual(resultado.estado, "fallida")
        self.assertNotIn(NAC["09"], self.cliente.pedidos)

    def test_pagina_html_en_el_archivo_de_nombre_fijo_es_una_falla(self):
        resultado = self.correr({NAC["09"]: xls("n")})
        self.assertEqual(resultado.estado, "fallida")
        self.assertIn("aperturas", resultado.error)
        self.assertEqual(self.uno("SELECT url FROM descarga WHERE estado = 'fallida'"), APERTURAS)

    def test_si_ningun_mes_candidato_existe_falla(self):
        resultado = self.correr({APERTURAS: xls("a")})
        self.assertEqual(resultado.estado, "fallida")
        self.assertIn("nacional", resultado.error)
        self.assertEqual(self.cliente.pedidos[:3], [NAC["10"], NAC["09"], NAC["08"]])

    def test_un_archivo_truncado_no_se_toma_por_publicado(self):
        corto = Respuesta(200, colector.MAGIA_XLS + b"x" * 100, "application/vnd.ms-excel", PUBLICADA)
        self.assertFalse(colector.es_xls(corto.contenido))
        resultado = self.correr({NAC["09"]: corto, APERTURAS: xls("a")})
        self.assertEqual(resultado.estado, "fallida")

    def test_un_error_inesperado_no_deja_la_corrida_en_curso(self):
        with self.assertRaises(RuntimeError):
            self.correr({NAC["09"]: RuntimeError("bug")})
        self.assertEqual(self.uno("SELECT estado FROM corrida"), "fallida")
        self.assertIn("RuntimeError", self.uno("SELECT error FROM corrida"))


class NombresTests(unittest.TestCase):
    def test_nombres_del_nacional_cruzan_el_cambio_de_anio(self):
        self.assertEqual(
            fuente.nombres_nacional(date(2027, 1, 15)),
            ("sh_ipc_01_27.xls", "sh_ipc_12_26.xls", "sh_ipc_11_26.xls"),
        )

    def test_nombres_del_nacional_el_mes_de_hoy_va_primero(self):
        self.assertEqual(fuente.nombres_nacional(HOY)[0], "sh_ipc_10_26.xls")


if __name__ == "__main__":
    unittest.main()
