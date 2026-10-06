"""Pipeline del IPC: de la colecta al candidato, con parser y validación falsos.

El orquestador no sabe leer un .xls ni qué es un salto atípico: recibe esas dos
piezas por parámetro. Acá se prueba que las une bien, que no deja nada a medias
y que cada final posible de la corrida queda registrado. La clase del final corre
la cadena real (parser y validación de Codex, y los .xls de INDEC) si están.
"""
import os
import unittest
from datetime import date
from decimal import Decimal
from pathlib import Path

from psycopg import errors

from servicio_datos import pipeline, repositorio
from servicio_datos.cliente_http import Respuesta
from servicio_datos.ipc import fuente
from servicio_datos.ipc.modelos import Hallazgo, SerieLeida
from servicio_datos.tests.test_colector import APERTURAS, HOY, NAC, PUBLICADA, BaseColector, ClienteFalso, xls

try:
    from servicio_datos.ipc import parser, validacion  # noqa: F401  (viven en la rama de Codex hasta integrarse)
    HAY_PARSER = True
except ImportError:
    HAY_PARSER = False


def serie(serie_id, archivo, hasta=(2026, 8), desde=(2026, 3), valor=100):
    """Una serie sintética mensual de `desde` a `hasta`: marzo de 2026 vale `valor`, abril `valor + 1`..."""
    meses, (anio, mes) = [], desde
    while (anio, mes) <= hasta:
        meses.append(date(anio, mes, 1))
        anio, mes = (anio + 1, 1) if mes == 12 else (anio, mes + 1)
    return SerieLeida(serie_id, archivo.clave, archivo.hoja, 10,
                      tuple((p, Decimal(valor + (p.year - 2026) * 12 + p.month - 3)) for p in meses), ())


class LectorFalso:
    """Imita a parser.leer_archivo: una serie por cada serie que el archivo configurado declara."""

    def __init__(self, **opciones):
        self.opciones, self.llamadas, self.error = opciones, [], None

    def __call__(self, ruta, archivo):
        self.llamadas.append((Path(ruta).name, archivo.clave))
        if self.error:
            raise self.error
        return {serie_id: serie(serie_id, archivo, **self.opciones) for serie_id in archivo.series.values()}


class ValidadorFalso:
    def __init__(self, hallazgos=()):
        self.hallazgos, self.llamadas, self.error = list(hallazgos), [], None

    def __call__(self, series, vigentes, descargas, *, hoy=None):
        self.llamadas.append({"series": series, "vigentes": vigentes, "descargas": descargas, "hoy": hoy})
        if self.error:
            raise self.error
        return list(self.hallazgos)


class BasePipeline(BaseColector):
    def setUp(self):
        super().setUp()
        self.leer, self.validar = LectorFalso(), ValidadorFalso()

    def correr(self, respuestas=None, **kwargs):
        self.cliente = ClienteFalso(self.publicado if respuestas is None else respuestas)
        kwargs.setdefault("leer_archivo", self.leer)
        kwargs.setdefault("validar", self.validar)
        return pipeline.correr_ipc(self.conn, self.almacen, self.cliente, HOY, **kwargs)

    def mes_nuevo(self):
        """Lo que INDEC publica el mes siguiente: un archivo nacional nuevo."""
        return {**self.publicado, NAC["10"]: xls("nacional-10")}

    def publicar(self, **opciones):
        """Deja un release vigente con lo que el lector falso devolvería con esas opciones."""
        repositorio.asegurar_series(self.conn, fuente.FUENTE_ID, fuente.SERIES, {})
        numero = self.release("ipc-vigente")
        for archivo in fuente.archivos(HOY):
            for serie_id in archivo.series.values():
                for periodo, valor in serie(serie_id, archivo, **opciones).observaciones:
                    self.conn.execute(
                        "INSERT INTO observacion (serie_id, periodo, valor, release_desde) VALUES (%s, %s, %s, %s)",
                        (serie_id, periodo, valor, numero))
        return numero

    def contar(self, tabla):
        return self.uno(f"SELECT count(*) FROM {tabla}")


class FinalesDeLaCorridaTests(BasePipeline):
    def test_primera_corrida_deja_un_candidato_abierto_con_todo_adentro(self):
        resultado = self.correr()
        self.assertEqual(resultado.estado, "con_candidato")
        self.assertEqual(self.uno("SELECT estado FROM candidato WHERE id = %s", (resultado.candidato_id,)), "abierto")
        self.assertEqual(self.contar("observacion_candidata"), 7 * 6)
        fila = self.conn.execute("SELECT estado, terminada_en, resumen FROM corrida WHERE id = %s", (resultado.corrida_id,)).fetchone()
        self.assertEqual(fila[0], "con_candidato")
        self.assertIsNotNone(fila[1])
        resumen = fila[2]
        self.assertEqual((resumen["series"], resumen["observaciones"], resumen["periodos_nuevos"]), (7, 42, 42))
        self.assertEqual((resumen["periodos_cambiados"], resumen["periodos_faltantes"]), (0, 0))
        self.assertEqual(resumen["hallazgos"], {"alta": 0, "media": 0, "baja": 0})
        # La colecta ya había dejado su parte del resumen: se suma, no se pisa.
        self.assertEqual([a["clave"] for a in resumen["archivos"]], ["nacional", "aperturas"])

    def test_crea_las_series_con_los_datos_del_catalogo(self):
        self.correr()
        self.assertEqual(self.contar("serie"), 7)
        fila = self.conn.execute(
            "SELECT nombre, territorio, nivel, hoja_origen, fila_origen FROM serie WHERE id = 'ipc_ng_gba'").fetchone()
        self.assertEqual(fila, ("IPC nivel general - Gran Buenos Aires", "Gran Buenos Aires", "Regional", "Índices aperturas", 10))

    def test_guarda_los_hallazgos_aunque_nombren_una_serie_desconocida(self):
        self.validar.hallazgos = [
            Hallazgo("cobertura", "alta", "ipc_ng_cuyo", date(2026, 7, 1), "ipc_ng_cuyo termina en 2026-07"),
            Hallazgo("estructura", "alta", "ipc_xx_inexistente", None, "La serie ipc_xx_inexistente no pertenece al IPC"),
            Hallazgo("fecha_normalizada", "baja", None, None, "Encabezado 2026-03-26 interpretado como 2026-03"),
        ]
        resultado = self.correr()
        self.assertEqual(len(resultado.hallazgos), 3)
        filas = {f[0]: f[1:] for f in self.conn.execute("SELECT regla, serie_id, periodo, severidad, detalle FROM hallazgo")}
        self.assertEqual(filas["cobertura"][:3], ("ipc_ng_cuyo", date(2026, 7, 1), "alta"))
        self.assertIsNone(filas["estructura"][0])
        self.assertIn("ipc_xx_inexistente", filas["estructura"][3])
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (resultado.corrida_id,))
        self.assertEqual(resumen["hallazgos"], {"alta": 2, "media": 0, "baja": 1})

    def test_sin_cambios_no_llama_ni_al_parser_ni_a_la_validacion(self):
        self.correr()
        llamadas = (len(self.leer.llamadas), len(self.validar.llamadas))
        resultado = self.correr()
        self.assertEqual(resultado.estado, "sin_cambios")
        self.assertEqual((len(self.leer.llamadas), len(self.validar.llamadas)), llamadas)
        self.assertEqual(self.contar("candidato"), 1)

    def test_si_la_colecta_falla_no_se_lee_nada(self):
        resultado = self.correr({NAC["09"]: xls("n")})
        self.assertEqual(resultado.estado, "fallida")
        self.assertIn("aperturas", resultado.error)
        self.assertEqual(self.leer.llamadas, [])

    def test_una_corrida_en_curso_la_deja_ocupada(self):
        self.conn.execute("INSERT INTO corrida (fuente_id, estado) VALUES ('INDEC_IPC', 'en_curso')")
        resultado = self.correr()
        self.assertEqual((resultado.estado, resultado.corrida_id), ("ocupado", None))
        self.assertEqual(self.leer.llamadas, [])

    def test_las_dos_descargas_llegan_a_la_validacion_con_la_fecha_del_pipeline(self):
        self.correr()
        llamada = self.validar.llamadas[0]
        self.assertEqual({d.clave: d.estado for d in llamada["descargas"]}, {"nacional": "nueva", "aperturas": "nueva"})
        self.assertEqual(llamada["hoy"], HOY)
        self.assertEqual(sorted(llamada["series"]), sorted(fuente.SERIES))


class FallosTests(BasePipeline):
    def test_un_archivo_que_el_parser_rechaza_cierra_la_corrida_como_fallida(self):
        self.leer.error = ValueError("No se pudo abrir la hoja «Índices aperturas»")
        resultado = self.correr()
        self.assertEqual(resultado.estado, "fallida")
        self.assertIn("No se pudo leer lo descargado", resultado.error)
        self.assertIn("Índices aperturas", resultado.error)
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (resultado.corrida_id,)), "fallida")
        self.assertEqual((self.contar("candidato"), self.contar("observacion_candidata")), (0, 0))
        # Lo que se bajó queda como constancia, aunque no sirva.
        self.assertEqual(self.contar("descarga"), 2)

    def test_lo_que_no_se_pudo_leer_se_vuelve_a_ver_como_nuevo(self):
        self.leer.error = ValueError("formato roto")
        self.correr()
        self.leer.error = None
        resultado = self.correr()
        self.assertEqual(resultado.estado, "con_candidato")

    def test_un_error_inesperado_no_deja_nada_a_medias_y_se_propaga(self):
        self.validar.error = RuntimeError("bug")
        with self.assertRaises(RuntimeError):
            self.correr()
        self.assertEqual(self.uno("SELECT estado FROM corrida"), "fallida")
        self.assertIn("RuntimeError", self.uno("SELECT error FROM corrida"))
        self.assertEqual((self.contar("candidato"), self.contar("observacion_candidata")), (0, 0))

    def test_si_falla_al_guardar_se_deshace_todo_el_candidato(self):
        # Una severidad fuera de las permitidas rompe el último paso, con el candidato ya armado.
        self.validar.hallazgos = [Hallazgo("regla", "critica", None, None, "x")]
        with self.assertRaises(errors.CheckViolation):
            self.correr()
        self.assertEqual((self.contar("candidato"), self.contar("observacion_candidata"), self.contar("hallazgo")), (0, 0, 0))
        self.assertEqual(self.contar("serie"), 1)  # solo la del armado de la prueba
        self.assertEqual(self.uno("SELECT estado FROM corrida"), "fallida")

    def test_sin_el_parser_real_avisa_que_falta(self):
        if HAY_PARSER:
            self.skipTest("El parser real está disponible")
        with self.assertRaisesRegex(RuntimeError, "parser y la validación"):
            pipeline.correr_ipc(self.conn, self.almacen, ClienteFalso({}), HOY)
        # Y no abre ninguna corrida: falla antes de tocar la base.
        self.assertEqual(self.contar("corrida"), 0)


class ContraLoPublicadoTests(BasePipeline):
    def test_un_mes_nuevo_se_cuenta_como_periodo_nuevo_por_serie(self):
        self.publicar(hasta=(2026, 7))
        resultado = self.correr()
        self.assertEqual(resultado.estado, "con_candidato")
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (resultado.corrida_id,))
        self.assertEqual((resumen["periodos_nuevos"], resumen["periodos_cambiados"], resumen["periodos_faltantes"]), (7, 0, 0))

    def test_la_validacion_recibe_lo_publicado_por_serie_y_periodo(self):
        self.publicar(hasta=(2026, 7))
        self.correr()
        vigentes = self.validar.llamadas[0]["vigentes"]
        self.assertEqual(sorted(vigentes), sorted(fuente.SERIES))
        self.assertEqual(vigentes["ipc_ng_gba"][date(2026, 3, 1)], Decimal("100"))
        self.assertEqual(vigentes["ipc_ng_gba"][date(2026, 7, 1)], Decimal("104"))
        self.assertNotIn(date(2026, 8, 1), vigentes["ipc_ng_gba"])

    def test_un_valor_publicado_que_cambia_cuenta_como_cambio(self):
        self.publicar(hasta=(2026, 8))

        # Con los mismos datos no habría candidato: se cambia el primer valor de una serie.
        def con_un_cambio(ruta, archivo):
            series = self.leer(ruta, archivo)
            if "ipc_ng_cuyo" in series:
                s = series["ipc_ng_cuyo"]
                series["ipc_ng_cuyo"] = SerieLeida(s.serie_id, s.archivo, s.hoja, s.fila_origen,
                                                   ((s.observaciones[0][0], Decimal("999")),) + s.observaciones[1:], s.notas)
            return series

        resultado = self.correr(leer_archivo=con_un_cambio)
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (resultado.corrida_id,))
        self.assertEqual((resultado.estado, resumen["periodos_cambiados"], resumen["periodos_nuevos"]), ("con_candidato", 1, 0))

    def test_archivos_nuevos_con_los_mismos_datos_no_son_una_novedad(self):
        self.publicar(hasta=(2026, 8))
        resultado = self.correr(self.mes_nuevo())
        self.assertEqual(resultado.estado, "sin_cambios")
        self.assertEqual(self.contar("candidato"), 1)  # el del release de la prueba: no se creó ninguno nuevo
        corrida = self.conn.execute("SELECT estado, resumen FROM corrida WHERE id = %s", (resultado.corrida_id,)).fetchone()
        self.assertEqual(corrida[0], "sin_cambios")
        self.assertIn("mismos datos", corrida[1]["motivo"])
        self.assertEqual(self.uno("SELECT count(*) FROM candidato WHERE corrida_id = %s", (resultado.corrida_id,)), 0)
        # Y como se dio por visto, mañana ese mismo archivo ya es idéntico.
        self.assertEqual(self.correr(self.mes_nuevo()).estado, "sin_cambios")


class CandidatosAnterioresTests(BasePipeline):
    def test_un_candidato_nuevo_reemplaza_al_que_esperaba_revision(self):
        primero = self.correr()
        segundo = self.correr(self.mes_nuevo())
        self.assertEqual(segundo.estado, "con_candidato")
        viejo = self.conn.execute(
            "SELECT estado, decidido_por, decidido_en FROM candidato WHERE id = %s", (primero.candidato_id,)).fetchone()
        self.assertEqual((viejo[0], viejo[1]), ("descartado", "sistema"))
        self.assertIsNotNone(viejo[2])
        self.assertEqual(self.uno("SELECT estado FROM candidato WHERE id = %s", (segundo.candidato_id,)), "abierto")
        self.assertEqual(self.uno("SELECT count(*) FROM candidato WHERE estado = 'abierto'"), 1)
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (segundo.corrida_id,))
        self.assertEqual(resumen["reemplaza_candidatos"], [primero.candidato_id])

    def test_lo_ya_revisado_al_publicar_no_vuelve_a_la_cola(self):
        a = Hallazgo("salto_mensual", "media", "ipc_ng_nacional", date(2026, 3, 1), "varió 25.00% en 2026-03")
        b = Hallazgo("fecha_normalizada", "baja", "ipc_ng_cuyo", None, "Encabezado 2026-03-26 interpretado como 2026-03")
        c = Hallazgo("cobertura", "alta", "ipc_ng_gba", date(2026, 7, 1), "ipc_ng_gba termina en 2026-07")
        self.validar.hallazgos = [a, b]
        primero = self.correr()
        # Se revisa y se publica ese candidato.
        self.conn.execute("UPDATE candidato SET estado = 'publicado', decidido_en = now(), decidido_por = 'juani' WHERE id = %s", (primero.candidato_id,))
        self.conn.execute("INSERT INTO release (release_id, candidato_id, aprobado_por, hash_contenido) VALUES ('ipc-1', %s, 'juani', %s)",
                          (primero.candidato_id, "a" * 64))
        self.validar.hallazgos = [a, b, c]
        segundo = self.correr(self.mes_nuevo())
        self.assertEqual(segundo.hallazgos, (c,))
        self.assertEqual(self.uno("SELECT count(*) FROM hallazgo WHERE corrida_id = %s", (segundo.corrida_id,)), 1)
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (segundo.corrida_id,))
        self.assertEqual((resumen["hallazgos_ya_revisados"], resumen["hallazgos"]["alta"]), (2, 1))

    def test_un_candidato_descartado_no_cuenta_como_revisado(self):
        a = Hallazgo("salto_mensual", "media", "ipc_ng_nacional", date(2026, 3, 1), "varió 25.00% en 2026-03")
        self.validar.hallazgos = [a]
        self.correr()
        segundo = self.correr(self.mes_nuevo())
        self.assertEqual(segundo.hallazgos, (a,))


def real(nombre):
    return Respuesta(200, (Path(os.environ.get("DATOS_IPC_ORIGINALES_DIR", "")) / nombre).read_bytes(),
                     "application/vnd.ms-excel", PUBLICADA)


ORIGINALES = Path(os.environ.get("DATOS_IPC_ORIGINALES_DIR", "/nonexistent"))


@unittest.skipUnless(
    HAY_PARSER and all((ORIGINALES / n).is_file() for n in ("sh_ipc_08_26.xls", "sh_ipc_09_26.xls", "sh_ipc_aperturas.xls")),
    "Falta el parser real (rama codex/ipc-parser) o DATOS_IPC_ORIGINALES_DIR con los .xls de INDEC",
)
class CadenaRealTests(BasePipeline):
    def test_con_los_archivos_vigentes_deja_un_candidato_de_819_observaciones(self):
        resultado = pipeline.correr_ipc(self.conn, self.almacen, ClienteFalso(
            {NAC["09"]: real("sh_ipc_09_26.xls"), APERTURAS: real("sh_ipc_aperturas.xls")}), HOY)
        self.assertEqual(resultado.estado, "con_candidato", resultado.error)
        self.assertEqual(self.contar("observacion_candidata"), 819)
        reglas = {h.regla for h in resultado.hallazgos}
        self.assertNotIn("cobertura", reglas)
        self.assertNotIn("frescura", reglas)
        self.assertIn("fecha_normalizada", reglas)
        self.assertEqual(self.uno("SELECT max(periodo) FROM observacion_candidata WHERE serie_id = 'ipc_ng_nacional'"), date(2026, 8, 1))

    def test_con_el_nacional_atrasado_marca_la_cobertura_y_la_frescura(self):
        # Lo que pasó con el piloto: el archivo de septiembre todavía no estaba y quedó el de agosto.
        resultado = pipeline.correr_ipc(self.conn, self.almacen, ClienteFalso(
            {NAC["08"]: real("sh_ipc_08_26.xls"), APERTURAS: real("sh_ipc_aperturas.xls")}), HOY)
        self.assertEqual(resultado.estado, "con_candidato", resultado.error)
        reglas = {(h.regla, h.serie_id) for h in resultado.hallazgos}
        self.assertIn(("cobertura", "ipc_ng_nacional"), reglas)
        self.assertIn(("frescura", "ipc_ng_nacional"), reglas)

    def test_la_segunda_corrida_con_lo_mismo_no_hace_nada(self):
        respuestas = {NAC["09"]: real("sh_ipc_09_26.xls"), APERTURAS: real("sh_ipc_aperturas.xls")}
        pipeline.correr_ipc(self.conn, self.almacen, ClienteFalso(respuestas), HOY)
        self.assertEqual(pipeline.correr_ipc(self.conn, self.almacen, ClienteFalso(respuestas), HOY).estado, "sin_cambios")


if __name__ == "__main__":
    unittest.main()
