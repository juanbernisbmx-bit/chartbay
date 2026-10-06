"""Los hechos que el código reúne sobre cada hallazgo, contra PostgreSQL y con series armadas a mano."""
import unittest
from datetime import date
from decimal import Decimal

from psycopg.types.json import Jsonb

from servicio_datos.agente import evidencia
from servicio_datos.tests.base import BaseEsquema

BASE = "https://www.indec.gob.ar/ftp/cuadros/economia/"
REGIONES = ("ipc_ng_gba", "ipc_ng_pampeana", "ipc_ng_noa", "ipc_ng_nea", "ipc_ng_cuyo", "ipc_ng_patagonia")
SERIES = ("ipc_ng_nacional", *REGIONES)
NOMBRE_NACIONAL = "IPC nivel general - Argentina"
ENE, FEB, MAR, ABR = (date(2026, m, 1) for m in (1, 2, 3, 4))
ARCHIVOS = {"nacional": (BASE + "sh_ipc_08_26.xls", "2026-08-13T15:00:00+00:00"),
            "aperturas": (BASE + "sh_ipc_aperturas.xls", "2026-09-14T15:00:00+00:00")}


def meses(*valores, desde=ENE):
    """{mes: valor} a partir de `desde`, un valor por mes."""
    return {date(desde.year + (desde.month - 1 + i) // 12, (desde.month - 1 + i) % 12 + 1, 1): Decimal(str(v)) for i, v in enumerate(valores)}


def todas(propia, otras):
    """Las siete series: la nacional con `propia` y las seis regionales con `otras` (una sola serie, o una por región)."""
    resto = otras if isinstance(otras, (list, tuple)) else [otras] * len(REGIONES)
    return {"ipc_ng_nacional": propia, **dict(zip(REGIONES, resto))}


class BaseEvidencia(BaseEsquema):
    def setUp(self):
        super().setUp()
        for serie_id in REGIONES:
            self.conn.execute("INSERT INTO serie (id, fuente_id, nombre, frecuencia) VALUES (%s, 'INDEC_IPC', %s, 'Mensual')", (serie_id, f"IPC nivel general - {serie_id}"))
        self.conn.execute("UPDATE serie SET nombre = %s WHERE id = 'ipc_ng_nacional'", (NOMBRE_NACIONAL,))

    def candidato(self, series, archivos=("nacional", "aperturas"), detalle=None, hallazgos=(), con_fechas=True):
        """Deja una corrida con candidato abierto con esas series. `detalle`: serie -> clave de archivo (por defecto, la nacional
        sale de 'nacional' y las demás de 'aperturas'). Devuelve (candidato_id, [hallazgos como los ve el analista])."""
        resumen = {"archivos": [{"clave": c, "url": ARCHIVOS[c][0], "estado": "nueva", "sha256": "a" * 64, "publicada_en": ARCHIVOS[c][1] if con_fechas else None} for c in archivos],
                   "detalle_series": {sid: {"archivo": (detalle or {}).get(sid, "nacional" if sid == "ipc_ng_nacional" else "aperturas")} for sid in series}}
        corrida = self.uno("INSERT INTO corrida (fuente_id, estado, terminada_en, resumen) VALUES ('INDEC_IPC', 'con_candidato', now(), %s) RETURNING id", (Jsonb(resumen),))
        candidato = self.uno("INSERT INTO candidato (corrida_id) VALUES (%s) RETURNING id", (corrida,))
        for serie_id, valores in series.items():
            for periodo, valor in valores.items():
                self.conn.execute("INSERT INTO observacion_candidata (candidato_id, serie_id, periodo, valor) VALUES (%s, %s, %s, %s)", (candidato, serie_id, periodo, valor))
        creados = []
        for regla, serie_id, periodo, detalle_h in hallazgos:
            hallazgo_id = self.uno("INSERT INTO hallazgo (corrida_id, serie_id, periodo, regla, severidad, detalle) VALUES (%s, %s, %s, %s, 'media', %s) RETURNING id",
                                   (corrida, serie_id, periodo, regla, detalle_h))
            creados.append({"id": hallazgo_id, "regla": regla, "serie_id": serie_id, "periodo": periodo, "detalle": detalle_h,
                            "serie_nombre": NOMBRE_NACIONAL if serie_id == "ipc_ng_nacional" else f"IPC nivel general - {serie_id}"})
        return candidato, creados

    def publicado(self, series, nombre="ipc-v1"):
        numero = self.release(nombre)
        for serie_id, valores in series.items():
            for periodo, valor in valores.items():
                self.conn.execute("INSERT INTO observacion (serie_id, periodo, valor, release_desde) VALUES (%s, %s, %s, %s)", (serie_id, periodo, valor, numero))

    def hechos(self, series, hallazgo, **kwargs):
        candidato, creados = self.candidato(series, hallazgos=[hallazgo], **kwargs)
        return evidencia.reunir_hechos(evidencia.cargar_contexto(self.conn, candidato), creados[0])

    def etiquetas(self, hechos):
        return set().union(*(h.etiquetas for h in hechos))

    def textos(self, hechos):
        return "\n".join(h.texto for h in hechos)


SALTO = ("salto_mensual", "ipc_ng_nacional", MAR, "ipc_ng_nacional varió 25.00% en 2026-03; supera el umbral de 20%.")


class SaltoMensualTests(BaseEvidencia):
    def test_un_salto_que_se_ve_en_todas_las_series_y_se_sostiene_es_sistemico_y_persistente(self):
        otras = [meses(100, 101, 101 * Decimal(m), 128) for m in ("1.24", "1.26", "1.27", "1.28", "1.25", "1.26")]
        hechos = self.hechos(todas(meses(100, 101, "126.25", 128), otras), SALTO)
        self.assertEqual([h.id for h in hechos], [1, 2, 3])
        self.assertEqual(hechos[0].texto, "IPC nivel general - Argentina: el índice pasa de 101,00 a 126,25 en mar 2026 (+25,0%).")
        self.assertIn("6 de las otras 6 series también se mueven en el mismo sentido (entre +24,0% y +28,0%)", hechos[1].texto)
        self.assertEqual(hechos[1].etiquetas, {"sistemico"})
        self.assertIn("El nivel nuevo se mantiene: al mes siguiente la serie varía +1,4%", hechos[2].texto)
        self.assertEqual(hechos[2].etiquetas, {"persistente"})

    def test_un_salto_solo_de_esta_serie_que_vuelve_atras_es_aislado_y_se_revierte(self):
        hechos = self.hechos(todas(meses(100, 101, "131.3", 102), meses(100, 101, 102, 103)), SALTO)
        self.assertEqual(self.etiquetas(hechos), {"valor", "aislado", "revierte"})
        self.assertIn("Ninguna de las otras 6 series se mueve más de 1,0% ese mes: el salto es propio de esta serie.", self.textos(hechos))
        self.assertIn("Al mes siguiente el valor vuelve a 102,00, cerca del nivel anterior (101,00): el salto se revierte.", self.textos(hechos))

    def test_si_es_el_ultimo_mes_no_hay_nada_que_decir_sobre_si_se_sostiene(self):
        hechos = self.hechos(todas(meses(100, 101, "126.25"), meses(100, 101, 102)), SALTO)
        self.assertEqual(self.etiquetas(hechos), {"valor", "aislado"})
        self.assertIn("Es el último mes cargado", self.textos(hechos))

    def test_un_salto_con_un_movimiento_parecido_en_las_demas_series_no_es_ni_aislado_ni_sistemico(self):
        otras = [meses(100, 101, "116.15", 117)] * 2 + [meses(100, 101, 102, 103)] * 4  # solo 2 de 6 se mueven (+15%)
        hechos = self.hechos(todas(meses(100, 101, "126.25", 127), otras), SALTO)
        self.assertEqual(self.etiquetas(hechos) & {"sistemico", "aislado"}, set())
        self.assertIn("2 de las otras 6 series se mueven en el mismo sentido y con una magnitud parecida", self.textos(hechos))

    def test_un_nivel_que_sigue_moviendose_mucho_no_se_da_por_persistente(self):
        hechos = self.hechos(todas(meses(100, 101, "126.25", 160), meses(100, 101, 102, 103)), SALTO)  # +26,7% el mes siguiente
        self.assertNotIn("persistente", self.etiquetas(hechos))
        self.assertIn("Al mes siguiente la serie varía +26,7%", self.textos(hechos))

    def test_un_salto_ya_publicado_con_el_mismo_valor_lo_dice(self):
        series = todas(meses(100, 101, "126.25", 128), meses(100, 101, 102, 103))
        self.publicado({"ipc_ng_nacional": meses(100, 101, "126.25")})
        self.assertIn("ya figura publicado con este mismo valor (ipc-v1): no es un dato nuevo.", self.textos(self.hechos(series, SALTO)))

    def test_un_valor_publicado_distinto_no_se_menciona(self):
        series = todas(meses(100, 101, "126.25", 128), meses(100, 101, 102, 103))
        self.publicado({"ipc_ng_nacional": meses(100, 101, 120)})
        self.assertNotIn("ya figura publicado", self.textos(self.hechos(series, SALTO)))

    def test_si_no_hay_mes_anterior_no_inventa_una_comparacion(self):
        hechos = self.hechos(todas(meses(100, desde=MAR), meses(100, desde=MAR)), SALTO)
        self.assertEqual(len(hechos), 1)
        self.assertEqual(hechos[0].etiquetas, set())

    def test_con_una_sola_serie_no_compara_con_otras(self):
        hechos = self.hechos({"ipc_ng_nacional": meses(100, 101, "126.25", 128)}, SALTO)
        self.assertEqual(self.etiquetas(hechos), {"valor", "persistente"})


class HistoriaIntactaTests(BaseEvidencia):
    def hallazgo(self, periodo=FEB, detalle="ipc_ng_nacional: 2026-02-01 pasó de 101 a 101.5."):
        return ("historia_intacta", "ipc_ng_nacional", periodo, detalle)

    def test_una_revision_de_varios_periodos_no_es_un_valor_suelto(self):
        self.publicado(todas(meses(100, 101, 102), meses(100, 101, 102)))
        hechos = self.hechos(todas(meses(100, "101.5", 103), meses(100, 101, 102)), self.hallazgo())
        self.assertEqual(hechos[0].texto, "IPC nivel general - Argentina: el valor publicado de feb 2026 era 101,00 y el candidato trae 101,50 (+0,5%).")
        self.assertIn("En esta serie cambian 2 períodos ya publicados (entre feb 2026 y mar 2026)", hechos[1].texto)
        self.assertEqual(self.etiquetas(hechos), {"valor", "revision"})

    def test_si_cambia_casi_todo_lo_publicado_es_sistemico(self):
        self.publicado(todas(meses(100, 101, 102), meses(100, 101, 102)))
        hechos = self.hechos(todas(meses(100, "101.5", 102), meses(100, "101.5", 102)), self.hallazgo())
        self.assertIn("Cambian datos ya publicados en 7 de las 7 series.", self.textos(hechos))
        self.assertIn("sistemico", self.etiquetas(hechos))

    def test_un_periodo_que_falta_en_el_candidato_se_dice_asi(self):
        self.publicado(todas(meses(100, 101, 102), meses(100, 101, 102)))
        hechos = self.hechos(todas({ENE: Decimal(100), MAR: Decimal(102)}, meses(100, 101, 102)), self.hallazgo(detalle="falta"))
        self.assertEqual(hechos[0].texto, "IPC nivel general - Argentina: el período feb 2026 está publicado (101,00) pero falta en el candidato.")

    def test_con_pocas_series_publicadas_no_se_habla_de_sistemico(self):
        self.publicado({"ipc_ng_nacional": meses(100, 101, 102), "ipc_ng_gba": meses(100, 101, 102)})
        hechos = self.hechos(todas(meses(100, "101.5", 102), meses(100, "101.5", 102)), self.hallazgo())
        self.assertNotIn("sistemico", self.etiquetas(hechos))

    def test_dice_cuando_se_publico_el_archivo_y_cuando_el_release(self):
        self.publicado(todas(meses(100, 101, 102), meses(100, 101, 102)))
        texto = self.textos(self.hechos(todas(meses(100, "101.5", 102), meses(100, 101, 102)), self.hallazgo()))
        self.assertRegex(texto, r"El archivo del dato nuevo \(sh_ipc_08_26\.xls\) lo publicó INDEC el 13 de agosto de 2026; el release vigente se publicó el \d+ de \w+ de 20\d\d\.")

    def test_sin_valor_publicado_para_comparar_no_afirma_nada(self):
        hechos = self.hechos(todas(meses(100, 101, 102), meses(100, 101, 102)), self.hallazgo())
        self.assertEqual((len(hechos), hechos[0].etiquetas), (1, set()))


class CoberturaTests(BaseEvidencia):
    HALLAZGO = ("cobertura", "ipc_ng_nacional", date(2026, 7, 1), "ipc_ng_nacional termina en 2026-07; otras series llegan a 2026-08.")

    def series(self):
        return todas(meses(100, 101, 102, 103, 104, 105, 106), meses(100, 101, 102, 103, 104, 105, 106, 107))

    def test_un_archivo_publicado_antes_que_el_de_las_series_al_dia_explica_el_desfase(self):
        hechos = self.hechos(self.series(), self.HALLAZGO)
        self.assertEqual(hechos[0].texto, "La serie IPC nivel general - Argentina termina en jul 2026; las que más avanzan llegan a ago 2026.")
        self.assertEqual(hechos[1].texto, "El archivo de esta serie (sh_ipc_08_26.xls) se publicó el 13 de agosto de 2026 y el de las que están al día "
                                          "(sh_ipc_aperturas.xls) el 14 de septiembre de 2026, 32 días después.")
        self.assertEqual(hechos[1].etiquetas, {"archivo"})

    def test_si_salen_del_mismo_archivo_el_desfase_no_se_explica_por_archivos(self):
        hechos = self.hechos(self.series(), self.HALLAZGO, detalle={sid: "nacional" for sid in SERIES})
        self.assertNotIn("archivo", self.etiquetas(hechos))
        self.assertIn("Las dos salen del mismo archivo (sh_ipc_08_26.xls)", self.textos(hechos))

    def test_si_el_archivo_de_esta_serie_es_el_mas_nuevo_tampoco_es_desfase_de_publicacion(self):
        hechos = self.hechos(self.series(), self.HALLAZGO, detalle={"ipc_ng_nacional": "aperturas", **{sid: "nacional" for sid in REGIONES}})
        self.assertNotIn("archivo", self.etiquetas(hechos))
        self.assertIn("no hay un desfase de publicación que explique la diferencia", self.textos(hechos))

    def test_sin_fechas_de_publicacion_no_hay_nada_que_comparar(self):
        hechos = self.hechos(self.series(), self.HALLAZGO, con_fechas=False)
        self.assertNotIn("archivo", self.etiquetas(hechos))
        self.assertIn("No hay fechas de publicación de los archivos para comparar.", self.textos(hechos))

    def test_una_serie_sin_datos_en_el_candidato(self):
        hechos = self.hechos({"ipc_ng_gba": meses(100, 101)}, self.HALLAZGO)
        self.assertEqual([h.texto for h in hechos], ["No hay datos de esa serie en el candidato."])


class OtrasReglasTests(BaseEvidencia):
    def test_una_fecha_normalizada_es_cosmetica_y_no_toca_valores(self):
        hechos = self.hechos(todas(meses(100, 101), meses(100, 101)), (
            "fecha_normalizada", "ipc_ng_nacional", None, "ipc_ng_nacional: Encabezado 2026-03-26 interpretado como período mensual 2026-03."))
        self.assertEqual(hechos[0].texto, "El parser registró: Encabezado 2026-03-26 interpretado como período mensual 2026-03.")
        self.assertEqual(self.etiquetas(hechos), {"cosmetico"})

    def test_una_base_distinta_se_dice_con_los_valores(self):
        self.publicado({"ipc_ng_nacional": meses(100, 101, desde=date(2016, 12, 1))})
        hechos = self.hechos({"ipc_ng_nacional": meses(1000, 1010, desde=date(2016, 12, 1))}, (
            "base_referencia", "ipc_ng_nacional", date(2016, 12, 1), "ipc_ng_nacional ya no inicia en diciembre de 2016 con índice 100."))
        self.assertEqual(hechos[0].texto, "IPC nivel general - Argentina: el primer valor del candidato es 1.000,00 en dic 2016; lo esperado es 100,00 en dic 2016.")
        self.assertEqual(hechos[0].etiquetas, {"base"})
        self.assertEqual(hechos[1].texto, "En el release vigente la serie arranca en dic 2016 con 100,00.")

    def test_una_regla_sin_colector_propio_informa_lo_que_dijo_la_validacion_y_no_sostiene_nada_mas(self):
        hechos = self.hechos(todas(meses(100, 101, 102, 103), meses(100, 101, 102, 103)), (
            "frescura", "ipc_ng_nacional", date(2026, 4, 1), "ipc_ng_nacional llega a 2026-04; al 2026-10-06 se esperaba al menos 2026-09."))
        self.assertEqual(hechos[0].texto, "La validación informó: ipc_ng_nacional llega a 2026-04; al 2026-10-06 se esperaba al menos 2026-09.")
        self.assertEqual(hechos[1].texto, "Últimos valores de la serie: feb 2026 101,00, mar 2026 102,00, abr 2026 103,00.")
        self.assertIn("lo publicó INDEC el 13 de agosto de 2026", hechos[2].texto)
        self.assertEqual(self.etiquetas(hechos), {"valor"})

    def test_un_hallazgo_sin_serie_ni_periodo_no_rompe(self):
        for regla in ("salto_mensual", "historia_intacta", "cobertura", "base_referencia", "estructura"):
            hechos = self.hechos(todas(meses(100, 101), meses(100, 101)), (regla, None, None, "Falta la serie esperada ipc_ng_x."))
            self.assertTrue(hechos, regla)
            self.assertFalse(self.etiquetas(hechos) - {"valor"}, regla)

    def test_es_deterministico(self):
        series = todas(meses(100, 101, "131.3", 102), meses(100, 101, 102, 103))
        candidato, creados = self.candidato(series, hallazgos=[SALTO])
        primero = evidencia.reunir_hechos(evidencia.cargar_contexto(self.conn, candidato), creados[0])
        segundo = evidencia.reunir_hechos(evidencia.cargar_contexto(self.conn, candidato), creados[0])
        self.assertEqual(primero, segundo)


class ContextoTests(BaseEvidencia):
    def test_lo_publicado_es_solo_de_la_fuente_del_candidato(self):
        self.conn.execute("INSERT INTO fuente (id, nombre) VALUES ('OTRA', 'Otra')")
        self.conn.execute("INSERT INTO serie (id, fuente_id, nombre, frecuencia) VALUES ('otra_serie', 'OTRA', 'Otra', 'Mensual')")
        self.publicado({"ipc_ng_nacional": meses(100, 101), "otra_serie": meses(5, 6)})
        candidato, _ = self.candidato({"ipc_ng_nacional": meses(100, 101)})
        contexto = evidencia.cargar_contexto(self.conn, candidato)
        self.assertEqual(sorted(contexto.vigente), ["ipc_ng_nacional"])
        self.assertEqual(contexto.release_vigente[0], "ipc-v1")

    def test_sin_release_vigente(self):
        candidato, _ = self.candidato({"ipc_ng_nacional": meses(100, 101)})
        contexto = evidencia.cargar_contexto(self.conn, candidato)
        self.assertIsNone(contexto.release_vigente)
        self.assertEqual(contexto.vigente, {})

    def test_a_cada_serie_le_toca_el_archivo_de_donde_salio(self):
        candidato, _ = self.candidato(todas(meses(100), meses(100)))
        archivos = evidencia.cargar_contexto(self.conn, candidato).archivos
        self.assertEqual((archivos["ipc_ng_nacional"].nombre, archivos["ipc_ng_gba"].nombre), ("sh_ipc_08_26.xls", "sh_ipc_aperturas.xls"))
        self.assertEqual(archivos["ipc_ng_gba"].publicada_en.day, 14)

    def test_el_candidato_no_mezcla_otros_candidatos(self):
        a, _ = self.candidato({"ipc_ng_nacional": meses(100, 101)})
        b, _ = self.candidato({"ipc_ng_nacional": meses(200, 201)})
        self.assertEqual(evidencia.cargar_contexto(self.conn, a).candidato["ipc_ng_nacional"][ENE], Decimal(100))
        self.assertEqual(evidencia.cargar_contexto(self.conn, b).candidato["ipc_ng_nacional"][ENE], Decimal(200))


class PrecedenteTests(BaseEvidencia):
    HALLAZGO = ("salto_mensual", "ipc_ng_nacional", MAR, "ipc_ng_nacional varió 25.00% en 2026-03; supera el umbral de 20%.")
    SERIES = {"ipc_ng_nacional": meses(100, 101, 126)}

    def candidato_con_hallazgo(self, hallazgo=None):
        candidato, creados = self.candidato(self.SERIES, hallazgos=[hallazgo or self.HALLAZGO])
        return candidato, creados[0]

    def decidir(self, hallazgo, decision, revisor="juani", comentario="Es la devaluación"):
        self.conn.execute("INSERT INTO revision_hallazgo (hallazgo_id, decision, revisor, comentario) VALUES (%s, %s, %s, %s)", (hallazgo["id"], decision, revisor, comentario))

    def descartar(self, candidato):
        self.conn.execute("UPDATE candidato SET estado = 'descartado', decidido_en = now(), decidido_por = 'sistema' WHERE id = %s", (candidato,))

    def test_sin_historia_no_hay_precedente(self):
        candidato, hallazgo = self.candidato_con_hallazgo()
        self.assertIsNone(evidencia.buscar_precedente(self.conn, candidato, hallazgo))

    def test_lo_que_una_persona_decidio_sobre_un_hallazgo_identico_de_otro_candidato(self):
        viejo, h_viejo = self.candidato_con_hallazgo()
        self.decidir(h_viejo, "aceptado")
        self.descartar(viejo)
        nuevo, h_nuevo = self.candidato_con_hallazgo()
        precedente = evidencia.buscar_precedente(self.conn, nuevo, h_nuevo)
        self.assertEqual((precedente["decision"], precedente["revisor"], precedente["comentario"], precedente["candidato_id"]), ("aceptado", "juani", "Es la devaluación", viejo))

    def test_vale_la_ultima_decision_y_la_mas_reciente_entre_candidatos(self):
        v1, h1 = self.candidato_con_hallazgo()
        self.decidir(h1, "rechazado", comentario="Parece un error")
        self.decidir(h1, "aceptado", comentario="Era real")
        self.descartar(v1)
        v2, h2 = self.candidato_con_hallazgo()
        self.decidir(h2, "rechazado", revisor="otra", comentario="Ahora no me convence")
        self.descartar(v2)
        nuevo, h_nuevo = self.candidato_con_hallazgo()
        precedente = evidencia.buscar_precedente(self.conn, nuevo, h_nuevo)
        self.assertEqual((precedente["decision"], precedente["revisor"], precedente["candidato_id"]), ("rechazado", "otra", v2))

    def test_un_hallazgo_sin_decidir_no_es_precedente(self):
        _, _ = self.candidato_con_hallazgo()
        nuevo, h_nuevo = self.candidato_con_hallazgo()
        self.assertIsNone(evidencia.buscar_precedente(self.conn, nuevo, h_nuevo))

    def test_no_se_toma_a_si_mismo_como_precedente(self):
        candidato, hallazgo = self.candidato_con_hallazgo()
        self.decidir(hallazgo, "aceptado")
        self.assertIsNone(evidencia.buscar_precedente(self.conn, candidato, hallazgo))

    def test_tiene_que_ser_identico_en_regla_serie_periodo_y_detalle(self):
        viejo, h_viejo = self.candidato_con_hallazgo()
        self.decidir(h_viejo, "aceptado")
        self.descartar(viejo)
        for cambio in (("cobertura",) + self.HALLAZGO[1:], self.HALLAZGO[:1] + ("ipc_ng_gba",) + self.HALLAZGO[2:], self.HALLAZGO[:2] + (ABR,) + self.HALLAZGO[3:],
                       self.HALLAZGO[:3] + ("ipc_ng_nacional varió 26.00% en 2026-03; supera el umbral de 20%.",)):
            nuevo, h_nuevo = self.candidato_con_hallazgo(cambio)
            self.assertIsNone(evidencia.buscar_precedente(self.conn, nuevo, h_nuevo), cambio)

    def test_un_hallazgo_sin_serie_ni_periodo_se_compara_por_igual(self):
        sin = ("estructura", None, None, "Falta la serie esperada ipc_ng_x.")
        viejo, h_viejo = self.candidato_con_hallazgo(sin)
        self.decidir(h_viejo, "rechazado", comentario="Hay que bajar de nuevo")
        self.descartar(viejo)
        nuevo, h_nuevo = self.candidato_con_hallazgo(sin)
        self.assertEqual(evidencia.buscar_precedente(self.conn, nuevo, h_nuevo)["decision"], "rechazado")


if __name__ == "__main__":
    unittest.main()
