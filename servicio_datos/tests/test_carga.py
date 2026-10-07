"""La validación del IPC y la carga del candidato en la base (migración 0011).

Lo central es comparar: `validar_ipc` tiene que dar exactamente los mismos hallazgos que `ipc/validacion.py` (mismas reglas,
mismos textos, mismo orden), y `cargar_candidato` lo mismo que el orquestador de Python con los mismos archivos.
"""
import random
import unittest
from datetime import date
from decimal import Decimal

import psycopg
from psycopg.types.json import Jsonb

from servicio_datos import carga, pipeline, publicacion, repositorio
from servicio_datos.ipc import fuente, validacion
from servicio_datos.ipc.modelos import SerieLeida
from servicio_datos.publicacion import ErrorPublicacion
from servicio_datos.tests.base import BaseEsquema
from servicio_datos.tests.test_pipeline import APERTURAS, HAY_PARSER, HOY, NAC, ORIGINALES, BasePipeline, ClienteFalso, real
from servicio_datos.tests.test_pipeline import serie as serie_sintetica
from servicio_datos.tests.test_validacion import BASE, ENERO, FEBRERO, conjunto, descarga
from servicio_datos.tests.test_validacion import serie as serie_v

HOY_V = date(2017, 3, 6)
REGIONES = tuple(fuente.REGIONES.values())
MARZO = date(2017, 3, 1)


class BaseParidad(BaseEsquema):
    def setUp(self):
        super().setUp()
        for serie_id in REGIONES:
            self.conn.execute("INSERT INTO serie (id, fuente_id, nombre, frecuencia) VALUES (%s, 'INDEC_IPC', %s, 'Mensual')", (serie_id, serie_id))

    def publicar_vigentes(self, vigentes):
        numero = self.release("ipc-vigente")
        for serie_id, valores in vigentes.items():
            for periodo, valor in sorted(valores.items()):
                self.conn.execute("INSERT INTO observacion (serie_id, periodo, valor, release_desde) VALUES (%s, %s, %s, %s)", (serie_id, periodo, valor, numero))

    def comparar(self, series, vigentes=None, descargados=(), hoy=HOY_V, msg=None):
        python = validacion.validar(series, vigentes or {}, [descarga(c) for c in descargados], hoy=hoy)
        sql = carga.validar(self.conn, series, descargados, hoy)
        self.assertEqual(sql, python, msg)
        return sql


class ValidacionParidadTests(BaseParidad):
    def test_una_serie_regular_no_da_hallazgos(self):
        self.assertEqual(self.comparar(conjunto(), descargados=("nacional", "aperturas")), [])

    def test_historia_revisada_y_omitida(self):
        vigentes = {"ipc_ng_nacional": {ENERO: Decimal("109"), MARZO: Decimal("118.0")}, "ipc_ng_gba": {FEBRERO: Decimal("113")}}
        self.publicar_vigentes(vigentes)
        reglas = [h.regla for h in self.comparar(conjunto(), vigentes)]
        self.assertEqual(reglas, ["historia_intacta", "historia_intacta"])

    def test_cobertura_cruce_regional_y_salto(self):
        datos = conjunto()
        datos["ipc_ng_nacional"] = serie_v("ipc_ng_nacional", (BASE, Decimal(100)), (ENERO, Decimal(130)), (FEBRERO, Decimal(131)))
        datos["ipc_ng_cuyo"] = serie_v("ipc_ng_cuyo", (BASE, Decimal(100)), (ENERO, Decimal(109)))
        reglas = {h.regla for h in self.comparar(datos)}
        self.assertEqual(reglas, {"salto_mensual", "cruce_regional", "cobertura"})

    def test_estructura_continuidad_y_rango(self):
        datos = conjunto()
        del datos["ipc_ng_noa"]
        datos["ipc_ng_extra"] = serie_v("ipc_ng_extra", (BASE, Decimal(100)))
        datos["ipc_ng_nea"] = serie_v("ipc_ng_nea")
        datos["ipc_ng_cuyo"] = serie_v("ipc_ng_cuyo", (date(2016, 12, 15), Decimal(100)), (MARZO, Decimal(-3)), (MARZO, Decimal("NaN")),
                                       (date(2017, 4, 1), Decimal("Infinity")), (date(2017, 5, 1), Decimal(0)))
        datos["ipc_ng_gba"] = serie_v("ipc_ng_gba", (BASE, Decimal(101)), (ENERO, Decimal(99)))
        reglas = {h.regla for h in self.comparar(datos)}
        self.assertTrue({"estructura", "continuidad", "rango", "base_referencia"} <= reglas)

    def test_notas_del_encabezado(self):
        datos = conjunto()
        datos["ipc_ng_cuyo"] = serie_v("ipc_ng_cuyo", *datos["ipc_ng_cuyo"].observaciones, notas=("Encabezado 2017-01-26 interpretado como período mensual 2017-01",))
        (hallazgo,) = self.comparar(datos)
        self.assertEqual(hallazgo.detalle, "ipc_ng_cuyo: Encabezado 2017-01-26 interpretado como período mensual 2017-01.")

    def test_frescura_alrededor_del_dia_limite_y_segun_lo_bajado(self):
        for hoy in (date(2017, 3, 25), date(2017, 3, 26), date(2017, 4, 25), date(2017, 4, 26), date(2018, 1, 3)):
            for descargados in ((), ("nacional",), ("nacional", "aperturas")):
                self.comparar(conjunto(), descargados=descargados, hoy=hoy, msg=(hoy, descargados))

    def test_el_redondeo_de_la_variacion_es_el_de_python_en_los_empates(self):
        datos = conjunto()
        # 100 → 125,125: la variación es exactamente 25,125 (empate). Python redondea al par: 25.12.
        datos["ipc_ng_cuyo"] = serie_v("ipc_ng_cuyo", (BASE, Decimal(100)), (ENERO, Decimal("125.125")), (FEBRERO, Decimal("125.125")))
        salto = [h for h in self.comparar(datos) if h.regla == "salto_mensual"]
        self.assertEqual(salto[0].detalle, "ipc_ng_cuyo varió 25.12% en 2017-01-01; supera el umbral de 20%.")

    def test_con_miles_de_variaciones_al_azar_da_lo_mismo(self):
        azar = random.Random(20261007)
        vigentes = {"ipc_ng_nacional": {ENERO: Decimal("110"), date(2017, 6, 1): Decimal("150.5")}, "ipc_ng_pampeana": {FEBRERO: Decimal("114")}}
        self.publicar_vigentes(vigentes)
        for vuelta in range(150):
            datos = {}
            for serie_id in ("ipc_ng_nacional", *REGIONES):
                valor, observaciones = Decimal(100), [(BASE, Decimal(100))]
                for mes in range(1, azar.randint(3, 14)):
                    valor = (valor * Decimal(str(round(azar.uniform(0.97, 1.06), 4)))).quantize(Decimal("0.0001"))
                    observaciones.append((date(2016 + (mes + 11) // 12, (mes + 11) % 12 + 1, 1), valor))
                notas = ("Encabezado interpretado",) if azar.random() < 0.1 else ()
                datos[serie_id] = serie_v(serie_id, *observaciones, notas=notas)
            for _ in range(azar.randint(0, 4)):
                serie_id = azar.choice(list(datos))
                obs = list(datos[serie_id].observaciones)
                cambio = azar.choice(("quitar", "repetir", "dia", "negativo", "nan", "infinito", "salto", "base", "vaciar", "borrar", "extra", "desordenar"))
                if cambio == "borrar":
                    del datos[serie_id]
                    continue
                if cambio == "extra":
                    datos["ipc_ng_extra"] = serie_v("ipc_ng_extra", (BASE, Decimal(100)))
                    continue
                i = azar.randrange(len(obs)) if obs else 0
                if obs and cambio == "quitar":
                    obs.pop(i)
                elif obs and cambio == "repetir":
                    obs.insert(i, obs[i])
                elif obs and cambio == "dia":
                    obs[i] = (obs[i][0].replace(day=azar.randint(2, 28)), obs[i][1])
                elif obs and cambio in ("negativo", "nan", "infinito", "salto"):
                    nuevo = {"negativo": Decimal("-1.5"), "nan": Decimal("NaN"), "infinito": Decimal("Infinity"),
                             "salto": (obs[i][1] * Decimal("1.3") if obs[i][1].is_finite() else Decimal(1)).quantize(Decimal("0.0001"))}[cambio]
                    obs[i] = (obs[i][0], nuevo)
                elif obs and cambio == "base":
                    obs[0] = (obs[0][0], Decimal("99.9"))
                elif cambio == "vaciar":
                    obs = []
                elif cambio == "desordenar" and len(obs) > 2:
                    obs[1], obs[2] = obs[2], obs[1]
                datos[serie_id] = serie_v(serie_id, *obs, notas=datos[serie_id].notas)
            hoy = date(2017, azar.randint(2, 12), azar.randint(1, 28))
            descargados = tuple(c for c in ("nacional", "aperturas") if azar.random() < 0.6)
            self.comparar(datos, vigentes, descargados, hoy, msg=f"vuelta {vuelta}")


@unittest.skipUnless(HAY_PARSER and all((ORIGINALES / n).is_file() for n in ("sh_ipc_08_26.xls", "sh_ipc_09_26.xls", "sh_ipc_aperturas.xls")),
                     "Falta xlrd o DATOS_IPC_ORIGINALES_DIR con los .xls de INDEC")
class ValidacionConArchivosRealesTests(BaseParidad):
    def leer(self, nacional):
        from servicio_datos.ipc import parser
        series = {}
        for archivo in fuente.archivos(HOY):
            series.update(parser.leer_archivo(ORIGINALES / (nacional if archivo.clave == "nacional" else "sh_ipc_aperturas.xls"), archivo))
        return series

    def test_los_archivos_vigentes_y_el_nacional_atrasado(self):
        for nacional in ("sh_ipc_09_26.xls", "sh_ipc_08_26.xls"):
            for hoy in (HOY, date(2026, 10, 27)):
                self.comparar(self.leer(nacional), descargados=("nacional", "aperturas"), hoy=hoy, msg=(nacional, hoy))

    def test_contra_lo_publicado_con_cambios(self):
        series = self.leer("sh_ipc_09_26.xls")
        vigentes = {sid: dict(s.observaciones) for sid, s in series.items()}
        vigentes["ipc_ng_cuyo"][date(2020, 5, 1)] += Decimal("0.0001")
        vigentes["ipc_ng_nacional"][date(2026, 9, 1)] = Decimal("9999.9")  # un mes publicado que el archivo no trae
        self.publicar_vigentes(vigentes)
        historia = [h for h in self.comparar(series, vigentes, ("nacional", "aperturas"), HOY) if h.regla == "historia_intacta"]
        self.assertEqual(len(historia), 2)


class CargaTests(BaseEsquema):
    def series(self, **opciones):
        resultado = {}
        for archivo in fuente.archivos(HOY):
            for serie_id in archivo.series.values():
                resultado[serie_id] = serie_sintetica(serie_id, archivo, **opciones)
        return resultado

    def abrir(self):
        corrida = repositorio.abrir_corrida_exclusiva(self.conn, fuente.FUENTE_ID, 1800)
        repositorio.guardar_resumen(self.conn, corrida, {"archivos": [{"clave": "nacional", "url": "https://x/n.xls"}]})
        return corrida

    def cargar(self, series=None, descargados=("nacional", "aperturas"), hoy=HOY, corrida=None):
        corrida = corrida or self.abrir()
        return corrida, carga.cargar_candidato(self.conn, corrida, hoy, series or self.series(), descargados)

    def corrida(self, corrida):
        return self.conn.execute("SELECT estado, resumen FROM corrida WHERE id = %s", (corrida,)).fetchone()

    def test_la_primera_carga_deja_un_candidato_con_todo(self):
        corrida, resultado = self.cargar()
        self.assertEqual((resultado["estado"], resultado["periodos_nuevos"], resultado["hallazgos"]), ("con_candidato", 42, 7))  # 7: no arrancan en dic-2016
        estado, resumen = self.corrida(corrida)
        self.assertEqual(estado, "con_candidato")
        self.assertEqual((resumen["candidato_id"], resumen["series"], resumen["observaciones"]), (resultado["candidato_id"], 7, 42))
        self.assertEqual((resumen["hallazgos"], resumen["hallazgos_ya_revisados"], resumen["reemplaza_candidatos"]), ({"alta": 7, "media": 0, "baja": 0}, 0, []))
        self.assertEqual(resumen["detalle_series"]["ipc_ng_gba"], {"archivo": "aperturas", "hoja": "Índices aperturas", "fila_origen": 10, "notas": []})
        self.assertEqual(resumen["archivos"][0]["clave"], "nacional")  # lo que dejó la colecta se suma, no se pisa
        self.assertEqual(self.uno("SELECT count(*) FROM observacion_candidata WHERE candidato_id = %s", (resultado["candidato_id"],)), 42)
        self.assertEqual(self.conn.execute("SELECT nombre, hoja_origen, fila_origen FROM serie WHERE id = 'ipc_ng_gba'").fetchone(),
                         ("IPC nivel general - Gran Buenos Aires", "Índices aperturas", 10))

    def test_lo_mismo_que_lo_publicado_cierra_sin_cambios(self):
        _, primero = self.cargar()
        publicacion.aceptar_pendientes(self.conn, primero["candidato_id"], "juani")
        publicacion.publicar_candidato(self.conn, primero["candidato_id"], "juani")
        corrida, segundo = self.cargar()
        self.assertEqual(segundo["estado"], "sin_cambios")
        estado, resumen = self.corrida(corrida)
        self.assertEqual((estado, resumen["motivo"]), ("sin_cambios", "Archivos nuevos con los mismos datos que el release vigente"))
        self.assertEqual(self.contar_candidatos(), 1)

    def contar_candidatos(self):
        return self.uno("SELECT count(*) FROM candidato")

    def test_un_dato_publicado_que_cambia_y_lo_ya_revisado_no_vuelve(self):
        _, primero = self.cargar()
        publicacion.aceptar_pendientes(self.conn, primero["candidato_id"], "juani")
        publicacion.publicar_candidato(self.conn, primero["candidato_id"], "juani")
        series = self.series()
        gba = series["ipc_ng_gba"]
        series["ipc_ng_gba"] = SerieLeida(gba.serie_id, gba.archivo, gba.hoja, gba.fila_origen,
                                          tuple((p, v + 1 if p == date(2026, 5, 1) else v) for p, v in gba.observaciones), ())
        corrida, segundo = self.cargar(series)
        self.assertEqual((segundo["estado"], segundo["periodos_cambiados"], segundo["hallazgos"], segundo["hallazgos_ya_revisados"]), ("con_candidato", 1, 1, 7))
        self.assertEqual(self.conn.execute("SELECT regla, detalle FROM hallazgo WHERE corrida_id = %s", (corrida,)).fetchall(),
                         [("historia_intacta", "ipc_ng_gba: 2026-05-01 pasó de 102 a 103.")])

    def test_un_candidato_abierto_queda_reemplazado(self):
        _, primero = self.cargar()
        corrida, segundo = self.cargar()
        self.assertEqual(segundo["reemplaza_candidatos"], [primero["candidato_id"]])
        self.assertEqual(self.conn.execute("SELECT estado, decidido_por, motivo FROM candidato WHERE id = %s", (primero["candidato_id"],)).fetchone(),
                         ("descartado", "sistema", f"Reemplazado por el candidato de la corrida {corrida}"))

    def test_la_frescura_mira_solo_lo_que_se_bajo(self):
        _, resultado = self.cargar(descargados=("nacional",), hoy=date(2026, 10, 27))
        frescura = self.conn.execute("SELECT serie_id FROM hallazgo WHERE regla = 'frescura'").fetchall()
        self.assertEqual(frescura, [("ipc_ng_nacional",)])

    def test_una_corrida_que_no_esta_en_curso_o_no_existe(self):
        corrida, _ = self.cargar()
        with self.assertRaises(ErrorPublicacion) as contexto:
            carga.cargar_candidato(self.conn, corrida, HOY, self.series(), ())
        self.assertEqual(contexto.exception.codigo, "corrida_cerrada")
        with self.assertRaises(ErrorPublicacion) as contexto:
            carga.cargar_candidato(self.conn, 99999, HOY, self.series(), ())
        self.assertEqual(contexto.exception.codigo, "no_existe")

    def test_una_carga_que_no_se_entiende_no_deja_nada(self):
        repetida = self.series()
        nac = repetida["ipc_ng_nacional"]
        repetida["ipc_ng_nacional"] = SerieLeida(nac.serie_id, nac.archivo, nac.hoja, nac.fila_origen, nac.observaciones + nac.observaciones[-1:], ())
        desconocida = {**self.series(), "ipc_ng_extra": SerieLeida("ipc_ng_extra", "aperturas", "x", 3, ((date(2016, 12, 1), Decimal(100)),), ())}
        corrida = self.abrir()
        for series, texto in ((repetida, "más de una vez en una serie"), (desconocida, "no está definida")):
            with self.assertRaises(ErrorPublicacion, msg=texto) as contexto:
                carga.cargar_candidato(self.conn, corrida, HOY, series, ())
            self.assertEqual(contexto.exception.codigo, "carga_invalida")
            self.assertIn(texto, str(contexto.exception))
        for malo in ({"series": []}, {"series": "x"}, {"series": [{"serie_id": "ipc_ng_gba", "observaciones": [["2026-03-01", "abc"]]}]},
                     {"series": [{"serie_id": "ipc_ng_gba", "observaciones": [["marzo", "100"]]}]}, {"series": [{"serie_id": "IPC GBA"}]}):
            with self.assertRaises(psycopg.Error) as contexto:
                self.conn.execute("SELECT cargar_candidato(%s, %s, %s)", (corrida, HOY, Jsonb(malo)))
            self.assertEqual((contexto.exception.sqlstate, contexto.exception.diag.message_detail), ("CB001", "carga_invalida"), malo)
        self.assertEqual((self.contar_candidatos(), self.corrida(corrida)[0]), (0, "en_curso"))


@unittest.skipUnless(HAY_PARSER and all((ORIGINALES / n).is_file() for n in ("sh_ipc_08_26.xls", "sh_ipc_09_26.xls", "sh_ipc_aperturas.xls")),
                     "Falta xlrd o DATOS_IPC_ORIGINALES_DIR con los .xls de INDEC")
class ParidadConElOrquestadorTests(BasePipeline):
    """Con los mismos archivos, la carga en la base deja lo mismo que el orquestador de Python."""

    def comparar(self, nacional):
        from servicio_datos.ipc import parser
        python = pipeline.correr_ipc(self.conn, self.almacen, ClienteFalso({NAC[nacional[7:9]]: real(nacional), APERTURAS: real("sh_ipc_aperturas.xls")}), HOY)
        self.assertEqual(python.estado, "con_candidato", python.error)
        series = {}
        for archivo in fuente.archivos(HOY):
            series.update(parser.leer_archivo(ORIGINALES / (nacional if archivo.clave == "nacional" else "sh_ipc_aperturas.xls"), archivo))
        corrida = repositorio.abrir_corrida_exclusiva(self.conn, fuente.FUENTE_ID, 1800)
        sql = carga.cargar_candidato(self.conn, corrida, HOY, series, ("nacional", "aperturas"))

        def observaciones(candidato):
            return self.conn.execute("SELECT serie_id, periodo, valor FROM observacion_candidata WHERE candidato_id = %s ORDER BY 1, 2", (candidato,)).fetchall()

        def hallazgos(corrida_id):
            return self.conn.execute("SELECT regla, severidad, serie_id, periodo, detalle FROM hallazgo WHERE corrida_id = %s ORDER BY id", (corrida_id,)).fetchall()

        def resumen(corrida_id):
            r = self.uno("SELECT resumen FROM corrida WHERE id = %s", (corrida_id,))
            return {k: v for k, v in r.items() if k not in ("candidato_id", "reemplaza_candidatos", "archivos")}

        self.assertEqual(observaciones(sql["candidato_id"]), observaciones(python.candidato_id))
        self.assertEqual(hallazgos(corrida), hallazgos(python.corrida_id))
        self.assertEqual(resumen(corrida), resumen(python.corrida_id))
        self.assertEqual(sql["reemplaza_candidatos"], [python.candidato_id])
        return hallazgos(corrida)

    def test_con_los_archivos_vigentes(self):
        self.assertIn("fecha_normalizada", {h[0] for h in self.comparar("sh_ipc_09_26.xls")})

    def test_con_el_nacional_atrasado(self):
        self.assertTrue({"cobertura", "frescura"} <= {h[0] for h in self.comparar("sh_ipc_08_26.xls")})


if __name__ == "__main__":
    unittest.main()
