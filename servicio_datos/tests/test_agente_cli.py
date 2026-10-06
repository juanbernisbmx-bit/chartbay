"""La prueba de calidad del modelo y la línea de comandos del analista (`python -m servicio_datos.agente`)."""
import contextlib
import io
import json
import os
import unittest
from unittest.mock import patch

from servicio_datos import publicacion
from servicio_datos.agente import __main__ as agente
from servicio_datos.agente import analista, autoprueba
from servicio_datos.agente.modelo import ErrorModelo, ModeloNoDisponible
from servicio_datos.tests.base import URL
from servicio_datos.tests.test_analista import BaseAnalista, ModeloFalso, dictamen
from servicio_datos.tests.test_evidencia import SALTO
from servicio_datos.tests.test_modelo import ServidorFalso

# Lo que contestaría un modelo que acierta cada caso de la prueba de calidad.
ORACULO = (
    dictamen(),
    dictamen(clasificacion="dato_real", accion_sugerida="aceptar", hechos_citados=[2, 3], razonamiento="Se ve en todas las series y se mantiene."),
    dictamen(clasificacion="cosmetico", accion_sugerida="aceptar", hechos_citados=[1, 2], razonamiento="Solo cambia cómo se leyó el encabezado."),
    dictamen(clasificacion="desfase_de_archivo", accion_sugerida="rechazar", hechos_citados=[1, 2], razonamiento="Su archivo se publicó antes."),
    dictamen(clasificacion="requiere_revision_humana", accion_sugerida="investigar", confianza="baja", hechos_citados=[1], razonamiento="No alcanza."),
)


class AutopruebaTests(unittest.TestCase):
    def test_los_casos_tienen_una_respuesta_valida_para_el_validador(self):
        resultados = autoprueba.correr(ModeloFalso(*ORACULO))
        self.assertEqual([r.obtenido for r in resultados], [c.esperado for c in autoprueba.CASOS])
        self.assertTrue(all(r.acierta and not r.corregido for r in resultados), resultados)

    def test_un_modelo_que_afirma_sin_respaldo_falla_y_se_nota_que_hubo_correcciones(self):
        presumido = ModeloFalso(dictamen(clasificacion="dato_real", accion_sugerida="aceptar", hechos_citados=[1]))
        resultados = autoprueba.correr(presumido)
        self.assertEqual(sum(r.acierta for r in resultados), 1)  # solo el caso en que lo correcto es no concluir
        self.assertTrue(all(r.corregido for r in resultados))

    def test_una_respuesta_inservible_cuenta_como_error_del_caso_y_sigue(self):
        resultados = autoprueba.correr(ModeloFalso(ErrorModelo("La respuesta del modelo no contiene un objeto JSON"), *ORACULO[1:]))
        self.assertEqual((resultados[0].obtenido, resultados[0].acierta), (None, False))
        self.assertIn("no contiene un objeto JSON", resultados[0].error)
        self.assertTrue(all(r.acierta for r in resultados[1:]))

    def test_si_el_servidor_no_esta_no_hay_nada_que_medir(self):
        with self.assertRaises(ModeloNoDisponible):
            autoprueba.correr(ModeloFalso(ModeloNoDisponible("No se pudo hablar con el servidor del modelo")))

    def test_los_casos_no_repiten_el_ejemplo_del_prompt(self):
        for caso in autoprueba.CASOS:
            self.assertNotIn(caso.hallazgo["detalle"], analista.PROMPT_SISTEMA)


class BaseCli(BaseAnalista):
    def cli(self, *args, entorno=None, url=True):
        direccion = f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"
        salida, errores = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, entorno or {}, clear=True), contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            codigo = agente.main([*args, *(["--url", direccion] if url else [])])
        return codigo, salida.getvalue(), errores.getvalue()

    def servidor(self, *respuestas):
        servidor = ServidorFalso().responde(*(json.dumps(r) if isinstance(r, dict) else r for r in respuestas))
        self.addCleanup(servidor.cerrar)
        return servidor

    def entorno(self, servidor, **extra):
        return {"DATOS_AGENTE_MODELO": "qwen2.5:7b", "DATOS_AGENTE_URL": servidor.url, **extra}


class AnalizarTests(BaseCli):
    def test_analiza_con_el_modelo_local_y_dice_que_hizo(self):
        servidor = self.servidor(dictamen())
        candidato, _ = self.con_hallazgos()
        codigo, salida, errores = self.cli(entorno=self.entorno(servidor))
        self.assertEqual((codigo, errores), (0, ""))
        resumen = json.loads(salida)
        self.assertEqual(resumen["modelo"], "qwen2.5:7b")
        self.assertEqual([(c["candidato"], c["por_modelo"], c["fallidos"]) for c in resumen["candidatos"]], [(candidato, 1, 0)])
        self.assertEqual(self.uno("SELECT modelo FROM propuesta"), "qwen2.5:7b")

    def test_sin_modelo_configurado_solo_repite_precedentes_y_lo_avisa(self):
        self.con_hallazgos()
        codigo, salida, errores = self.cli()
        self.assertEqual(codigo, 0)
        self.assertIn("No hay modelo configurado", errores)
        self.assertEqual(json.loads(salida)["candidatos"][0]["sin_modelo"], 1)
        self.assertIsNone(json.loads(salida)["modelo"])

    def test_si_el_servidor_del_modelo_esta_caido_sale_con_error_para_que_el_cron_lo_marque(self):
        self.con_hallazgos()
        codigo, salida, _ = self.cli(entorno={"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_URL": "http://127.0.0.1:1/v1"})
        self.assertEqual(codigo, 1)
        resumen = json.loads(salida)["candidatos"][0]
        self.assertEqual((resumen["fallidos"], resumen["por_modelo"]), (1, 0))
        self.assertEqual(self.uno("SELECT count(*) FROM propuesta"), 0)

    def test_sin_nada_abierto_no_hace_nada(self):
        codigo, salida, _ = self.cli(entorno=self.entorno(self.servidor(dictamen())))
        self.assertEqual((codigo, json.loads(salida)["candidatos"]), (0, []))

    def test_una_configuracion_invalida_se_rechaza_sin_tocar_la_base(self):
        for entorno in ({"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_URL": "http://example.com/v1"}, {"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_TIMEOUT": "abc"}):
            codigo, salida, errores = self.cli(entorno=entorno)
            self.assertEqual((codigo, salida), (1, ""))
            self.assertIn("Error de configuración", errores)

    def test_el_limite_de_tiempo_se_respeta(self):
        self.con_hallazgos(*self.cosmeticos(3))
        codigo, salida, _ = self.cli("--limite", "0", entorno=self.entorno(self.servidor(dictamen())))
        self.assertEqual(codigo, 0)
        self.assertEqual(json.loads(salida)["candidatos"][0]["sin_tiempo"], 3)

    def test_sin_url_pide_la_url(self):
        with self.assertRaises(SystemExit) as contexto, contextlib.redirect_stderr(io.StringIO()):
            self.cli(url=False)
        self.assertEqual(contexto.exception.code, 2)


class ProbarTests(BaseCli):
    def test_mide_cuantos_casos_clasifica_bien(self):
        codigo, salida, _ = self.cli("probar", url=False, entorno=self.entorno(self.servidor(*ORACULO)))
        self.assertEqual(codigo, 0)
        self.assertIn("qwen2.5:7b: 5 de 5 casos bien clasificados; el validador corrigió 0", salida)
        self.assertNotIn("MAL", salida)
        self.assertNotIn("más grande", salida)

    def test_un_modelo_flojo_se_ve_y_se_recomienda_otro(self):
        presumido = self.servidor(dictamen(clasificacion="dato_real", accion_sugerida="aceptar", hechos_citados=[1]))
        codigo, salida, _ = self.cli("probar", url=False, entorno=self.entorno(presumido))
        self.assertEqual(codigo, 0)
        self.assertIn("1 de 5 casos bien clasificados", salida)
        self.assertRegex(salida, r"MAL  un salto que se ve en una sola serie y se revierte \(\d+\.\d s\): dijo «requiere_revision_humana», con correcciones del validador")
        self.assertIn("esperado: «posible_error_de_carga»", salida)
        self.assertIn("probá con un modelo más grande", salida)

    def test_sin_modelo_configurado_lo_dice(self):
        codigo, _, errores = self.cli("probar", url=False)
        self.assertEqual(codigo, 1)
        self.assertIn("DATOS_AGENTE_MODELO", errores)

    def test_si_el_servidor_no_esta_sale_con_error_y_sin_la_direccion(self):
        codigo, _, errores = self.cli("probar", url=False, entorno={"DATOS_AGENTE_MODELO": "m", "DATOS_AGENTE_URL": "http://127.0.0.1:1/v1"})
        self.assertEqual(codigo, 1)
        self.assertIn("El modelo no responde", errores)
        self.assertNotIn("127.0.0.1", errores)


class EstadoTests(BaseCli):
    def test_sin_propuestas(self):
        codigo, salida, _ = self.cli("estado")
        self.assertEqual((codigo, salida.strip()), (0, "Todavía no hay propuestas del analista."))

    def test_cuenta_las_propuestas_y_cuanto_coincidieron_con_las_personas(self):
        otro_salto = SALTO[:3] + ("otro aviso sobre el mismo salto",)
        candidato, (a, b, c) = self.con_hallazgos(SALTO, otro_salto, *self.cosmeticos(1))
        analista.analizar_candidato(self.conn, candidato, ModeloFalso(
            dictamen(), dictamen(), dictamen(clasificacion="dato_real", accion_sugerida="aceptar", hechos_citados=[1, 99])))  # el último se corrige
        publicacion.revisar_hallazgo(self.conn, a, "rechazado", "juani", "Era un error")  # coincide con lo que proponía
        publicacion.revisar_hallazgo(self.conn, b, "aceptado", "juani", "No es un error")  # proponía rechazar
        codigo, salida, _ = self.cli("estado")
        self.assertEqual(codigo, 0)
        self.assertIn("agente: 3 propuestas, 1 sin decidir; de 2 que sugerían aceptar o rechazar y ya decidió una persona, coincidió en 1 (50%); el validador corrigió 1 de 3", salida)


if __name__ == "__main__":
    unittest.main()
