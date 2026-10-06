"""Revisión de hallazgos y publicación de un candidato, contra PostgreSQL.

Los candidatos salen del pipeline real con parser y validación falsos: así se prueba la
publicación sobre lo que de verdad deja el orquestador, incluido el ciclo completo
(publicar, y que la corrida siguiente lo reconozca).
"""
import contextlib
import io
import unittest
from datetime import date
from decimal import Decimal

from psycopg import errors

from servicio_datos import publicacion, publicar, repositorio
from servicio_datos.ipc import fuente
from servicio_datos.ipc.modelos import Hallazgo, SerieLeida
from servicio_datos.publicacion import ErrorPublicacion
from servicio_datos.tests.base import URL
from servicio_datos.tests.test_colector import NAC, xls
from servicio_datos.tests.test_pipeline import BasePipeline

FECHA = date(2026, 10, 6)
A = Hallazgo("salto_mensual", "media", "ipc_ng_nacional", date(2026, 3, 1), "varió 25.00% en 2026-03")
B = Hallazgo("fecha_normalizada", "baja", "ipc_ng_cuyo", None, "Encabezado 2026-03-26 interpretado como 2026-03")
C = Hallazgo("cobertura", "alta", "ipc_ng_gba", date(2026, 7, 1), "ipc_ng_gba termina en 2026-07")


class BasePublicacion(BasePipeline):
    def candidato(self, respuestas=None, hallazgos=(), **opciones):
        """Corre el pipeline y devuelve el id del candidato abierto que deja."""
        self.validar.hallazgos = list(hallazgos)
        self.leer.opciones = opciones
        resultado = self.correr(respuestas)
        self.assertEqual(resultado.estado, "con_candidato", resultado.error)
        return resultado.candidato_id

    def hallazgos_de(self, candidato_id):
        return [f[0] for f in self.conn.execute(
            "SELECT h.id FROM hallazgo h JOIN candidato c ON c.corrida_id = h.corrida_id WHERE c.id = %s ORDER BY h.id",
            (candidato_id,))]

    def aceptar_todos(self, candidato_id, revisor="juani"):
        for hallazgo_id in self.hallazgos_de(candidato_id):
            publicacion.revisar_hallazgo(self.conn, hallazgo_id, "aceptado", revisor, "Revisado")

    def publicar(self, candidato_id, por="juani"):
        return publicacion.publicar_candidato(self.conn, candidato_id, por, fecha=FECHA)

    def rechaza(self, codigo, funcion, *args, **kwargs):
        with self.assertRaises(ErrorPublicacion) as contexto:
            funcion(*args, **kwargs)
        self.assertEqual(contexto.exception.codigo, codigo)
        return str(contexto.exception)

    def nada_publicado(self):
        self.assertEqual((self.contar("observacion"), self.uno("SELECT count(*) FROM release")), (0, 0))

    def valor_en(self, serie_id, periodo, release):
        fila = self.conn.execute(
            "SELECT valor FROM observacion WHERE serie_id = %s AND periodo = %s AND release_desde <= %s "
            "AND (release_hasta IS NULL OR release_hasta > %s)", (serie_id, periodo, release, release)).fetchone()
        return fila[0] if fila else None


class PublicarTests(BasePublicacion):
    def test_publica_un_candidato_sin_hallazgos(self):
        candidato = self.candidato()
        p = self.publicar(candidato)
        self.assertEqual((p.observaciones_abiertas, p.observaciones_cerradas, p.observaciones_sin_cambio), (42, 0, 0))
        fila = self.conn.execute(
            "SELECT release_id, aprobado_por, hash_contenido, candidato_id FROM release WHERE numero = %s", (p.release_numero,)).fetchone()
        self.assertEqual(fila[0], p.release_id)
        self.assertRegex(p.release_id, r"^ipc-2026-10-06-[0-9a-f]{10}$")
        self.assertEqual((fila[1], fila[2], fila[3]), ("juani", p.hash_contenido, candidato))
        self.assertEqual(self.contar("observacion_vigente"), 42)
        self.assertEqual(self.uno("SELECT count(*) FROM observacion WHERE release_desde = %s AND release_hasta IS NULL", (p.release_numero,)), 42)
        estado = self.conn.execute("SELECT estado, decidido_por, decidido_en FROM candidato WHERE id = %s", (candidato,)).fetchone()
        self.assertEqual(estado[:2], ("publicado", "juani"))
        self.assertIsNotNone(estado[2])

    def test_lo_publicado_es_lo_que_el_pipeline_lee_como_vigente(self):
        self.publicar(self.candidato())
        vigentes = repositorio.vigentes(self.conn, fuente.FUENTE_ID)
        self.assertEqual(sorted(vigentes), sorted(fuente.SERIES))
        self.assertEqual(vigentes["ipc_ng_gba"][date(2026, 3, 1)], Decimal("100"))
        self.assertEqual(len(vigentes["ipc_ng_gba"]), 6)

    def test_el_hash_depende_del_dato_y_no_de_como_se_escribio(self):
        base = [("a", date(2026, 1, 1), Decimal("100")), ("b", date(2026, 2, 1), Decimal("101.5859"))]
        self.assertEqual(publicacion.hash_contenido(base), publicacion.hash_contenido(reversed(base)))
        self.assertEqual(publicacion.hash_contenido(base),
                         publicacion.hash_contenido([("a", date(2026, 1, 1), Decimal("100.000")), base[1]]))
        self.assertNotEqual(publicacion.hash_contenido(base),
                            publicacion.hash_contenido([("a", date(2026, 1, 1), Decimal("100.1")), base[1]]))
        self.assertNotEqual(publicacion.hash_contenido(base), publicacion.hash_contenido(base[:1]))

    def test_publicar_dos_veces_o_algo_que_no_esta_abierto_se_rechaza(self):
        candidato = self.candidato()
        self.publicar(candidato)
        self.rechaza("no_abierto", self.publicar, candidato)
        self.assertEqual(self.uno("SELECT count(*) FROM release"), 1)
        self.rechaza("no_existe", self.publicar, 99999)

    def test_exige_quien_aprueba(self):
        candidato = self.candidato()
        for vacio in ("", "   "):
            self.rechaza("aprobador_vacio", self.publicar, candidato, vacio)
        self.nada_publicado()


class RevisionTests(BasePublicacion):
    def test_hallazgos_pendientes_bloquean_y_dicen_cuantos_faltan(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        mensaje = self.rechaza("hallazgos_pendientes", self.publicar, candidato)
        self.assertIn("Faltan 3 hallazgos", mensaje)
        self.nada_publicado()
        self.assertEqual(self.uno("SELECT estado FROM candidato WHERE id = %s", (candidato,)), "abierto")

    def test_con_uno_solo_pendiente_el_mensaje_va_en_singular(self):
        candidato = self.candidato(hallazgos=[A])
        self.assertIn("Faltan 1 hallazgo por resolver", self.rechaza("hallazgos_pendientes", self.publicar, candidato))

    def test_aceptados_a_medias_siguen_bloqueando(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        publicacion.revisar_hallazgo(self.conn, self.hallazgos_de(candidato)[0], "aceptado", "juani", "ok")
        self.assertIn("Faltan 2 hallazgos", self.rechaza("hallazgos_pendientes", self.publicar, candidato))
        revision = publicacion.estado_revision(self.conn, candidato)
        self.assertEqual((revision.total, revision.aceptados, revision.rechazados, revision.pendientes), (3, 1, 0, 2))

    def test_con_todos_aceptados_publica(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        self.aceptar_todos(candidato)
        self.assertEqual(self.publicar(candidato).observaciones_abiertas, 42)

    def test_un_hallazgo_rechazado_bloquea_aunque_el_resto_este_aceptado(self):
        candidato = self.candidato(hallazgos=[A, B])
        primero, segundo = self.hallazgos_de(candidato)
        publicacion.revisar_hallazgo(self.conn, primero, "aceptado", "juani", "ok")
        publicacion.revisar_hallazgo(self.conn, segundo, "rechazado", "juani", "El valor está mal cargado")
        self.assertIn("1 hallazgo rechazado", self.rechaza("hallazgos_rechazados", self.publicar, candidato))
        self.nada_publicado()

    def test_rechazar_exige_un_motivo(self):
        candidato = self.candidato(hallazgos=[A])
        for comentario in (None, "", "   "):
            self.rechaza("revision_invalida", publicacion.revisar_hallazgo, self.conn, self.hallazgos_de(candidato)[0],
                         "rechazado", "juani", comentario)
        self.assertEqual(self.contar("revision_hallazgo"), 0)

    def test_decision_o_revisor_invalidos(self):
        hallazgo = self.hallazgos_de(self.candidato(hallazgos=[A]))[0]
        self.rechaza("revision_invalida", publicacion.revisar_hallazgo, self.conn, hallazgo, "quizás", "juani")
        self.rechaza("revision_invalida", publicacion.revisar_hallazgo, self.conn, hallazgo, "aceptado", "  ")
        self.rechaza("revision_invalida", publicacion.revisar_hallazgo, self.conn, 99999, "aceptado", "juani")

    def test_cambiar_de_opinion_vale_la_ultima_y_el_historial_queda(self):
        candidato = self.candidato(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        publicacion.revisar_hallazgo(self.conn, hallazgo, "rechazado", "juani", "Parece un error")
        self.rechaza("hallazgos_rechazados", self.publicar, candidato)
        publicacion.revisar_hallazgo(self.conn, hallazgo, "aceptado", "juani", "Es la devaluación, es real")
        self.assertEqual(self.publicar(candidato).observaciones_abiertas, 42)
        self.assertEqual(self.uno("SELECT count(*) FROM revision_hallazgo WHERE hallazgo_id = %s", (hallazgo,)), 2)

    def test_las_revisiones_no_se_editan_ni_se_borran(self):
        hallazgo = self.hallazgos_de(self.candidato(hallazgos=[A]))[0]
        publicacion.revisar_hallazgo(self.conn, hallazgo, "aceptado", "juani", "ok")
        with self.assertRaises(errors.RaiseException):
            self.conn.execute("UPDATE revision_hallazgo SET decision = 'rechazado'")
        with self.assertRaises(errors.RaiseException):
            self.conn.execute("DELETE FROM revision_hallazgo")

    def test_una_propuesta_del_agente_sin_decidir_bloquea(self):
        candidato = self.candidato(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        self.conn.execute("INSERT INTO propuesta (hallazgo_id, tipo, confianza) VALUES (%s, 'nota', 'media')", (hallazgo,))
        publicacion.revisar_hallazgo(self.conn, hallazgo, "aceptado", "juani", "ok")
        self.assertIn("1 propuesta", self.rechaza("propuestas_pendientes", self.publicar, candidato))
        self.conn.execute("UPDATE propuesta SET estado = 'rechazada', revisor = 'juani', decidida_en = now(), comentario = 'no aplica'")
        self.assertEqual(self.publicar(candidato).observaciones_abiertas, 42)

    def test_no_se_revisan_hallazgos_de_un_candidato_que_ya_no_esta_abierto(self):
        candidato = self.candidato(hallazgos=[A])
        hallazgo = self.hallazgos_de(candidato)[0]
        publicacion.revisar_hallazgo(self.conn, hallazgo, "aceptado", "juani", "ok")
        self.publicar(candidato)
        self.rechaza("candidato_cerrado", publicacion.revisar_hallazgo, self.conn, hallazgo, "rechazado", "juani", "tarde")
        self.assertEqual(self.contar("revision_hallazgo"), 1)


class ProcedenciaYLecturaTests(BasePublicacion):
    """Lo que el release lleva congelado y lo que ChartBay lee de él."""

    def procedencia(self, numero):
        return self.uno("SELECT procedencia FROM release WHERE numero = %s", (numero,))

    def test_el_release_congela_los_archivos_con_hash_y_fechas(self):
        p = self.publicar(self.candidato())
        archivos = {a["clave"]: a for a in self.procedencia(p.release_numero)["archivos"]}
        self.assertEqual(sorted(archivos), ["aperturas", "nacional"])
        nacional = archivos["nacional"]
        self.assertEqual(nacional["file"], "sh_ipc_09_26.xls")
        self.assertEqual(nacional["url"], NAC["09"])
        self.assertEqual(nacional["sha256"], self.uno("SELECT sha256 FROM descarga WHERE url = %s", (NAC["09"],)))
        self.assertEqual(nacional["published_at"], "2026-09-10T18:52:05+00:00")  # el Last-Modified de la fuente
        self.assertRegex(nacional["retrieved_at"], r"^\d{4}-\d{2}-\d{2}T[\d:.]+\+00:00$")

    def test_el_release_congela_de_donde_salio_cada_serie(self):
        p = self.publicar(self.candidato())
        series = self.procedencia(p.release_numero)["series"]
        self.assertEqual(sorted(series), sorted(fuente.SERIES))
        self.assertEqual(series["ipc_ng_nacional"], {"archivo": "nacional", "hoja": "Índices IPC Cobertura Nacional", "fila_origen": 10, "notas": []})
        self.assertEqual(series["ipc_ng_cuyo"]["archivo"], "aperturas")

    def test_las_notas_de_normalizacion_viajan_con_el_release(self):
        nota = "Encabezado 2026-03-26 interpretado como período mensual 2026-03"
        original = self.leer

        def con_nota(ruta, archivo):
            series = original(ruta, archivo)
            if "ipc_ng_cuyo" in series:
                s = series["ipc_ng_cuyo"]
                series["ipc_ng_cuyo"] = SerieLeida(s.serie_id, s.archivo, s.hoja, s.fila_origen, s.observaciones, (nota,))
            return series
        self.leer = con_nota
        self.validar.hallazgos = [Hallazgo("fecha_normalizada", "baja", "ipc_ng_cuyo", None, nota)]
        resultado = self.correr()
        self.aceptar_todos(resultado.candidato_id)
        p = self.publicar(resultado.candidato_id)
        self.assertEqual(self.procedencia(p.release_numero)["series"]["ipc_ng_cuyo"]["notas"], [nota])

    def test_la_captura_es_la_primera_vez_que_se_vio_el_archivo(self):
        primero = self.publicar(self.candidato())
        segundo = self.publicar(self.candidato(self.mes_nuevo(), valor=200))
        a1 = {a["clave"]: a for a in self.procedencia(primero.release_numero)["archivos"]}
        a2 = {a["clave"]: a for a in self.procedencia(segundo.release_numero)["archivos"]}
        # Las aperturas no cambiaron: se las volvió a ver, pero se capturaron la primera vez.
        self.assertEqual(a2["aperturas"]["retrieved_at"], a1["aperturas"]["retrieved_at"])
        self.assertNotEqual(a2["nacional"]["retrieved_at"], a1["nacional"]["retrieved_at"])
        self.assertEqual(a2["nacional"]["file"], "sh_ipc_10_26.xls")

    def test_las_vistas_muestran_solo_el_release_vigente(self):
        self.assertEqual((self.contar("publicado_release"), self.contar("publicado_observaciones")), (0, 0))
        primero = self.publicar(self.candidato(hasta=(2026, 7)))
        segundo = self.publicar(self.candidato(self.mes_nuevo(), hasta=(2026, 8)))
        vistas = self.conn.execute("SELECT fuente_id, numero, release_id, hash_contenido FROM publicado_release").fetchall()
        self.assertEqual(vistas, [("INDEC_IPC", segundo.release_numero, segundo.release_id, segundo.hash_contenido)])
        self.assertNotEqual(primero.release_numero, segundo.release_numero)
        self.assertEqual(self.contar("publicado_observaciones"), 42)
        self.assertEqual(self.uno("SELECT max(periodo) FROM publicado_observaciones"), date(2026, 8, 1))

    def test_el_contrato_de_las_vistas_no_cambia_sin_avisar(self):
        # ChartBay depende de estas columnas por nombre: si cambian, hay que cambiar la web.
        def columnas(vista):
            return [f[0] for f in self.conn.execute(
                "SELECT column_name FROM information_schema.columns WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position",
                (self.schema, vista))]
        self.assertEqual(columnas("publicado_release"), ["fuente_id", "numero", "release_id", "publicado_en", "hash_contenido", "procedencia"])
        self.assertEqual(columnas("publicado_observaciones"), ["fuente_id", "serie_id", "periodo", "valor"])


class VersionadoTests(BasePublicacion):
    def segundo_mes(self, cambios):
        """Un candidato con un mes más y, opcionalmente, valores distintos: {(serie, periodo): valor}."""
        original = self.leer

        def lector(ruta, archivo):
            series = original(ruta, archivo)
            for (serie_id, periodo), valor in cambios.items():
                if serie_id in series:
                    s = series[serie_id]
                    series[serie_id] = SerieLeida(s.serie_id, s.archivo, s.hoja, s.fila_origen, tuple(
                        (p, Decimal(valor) if p == periodo else v) for p, v in s.observaciones), s.notas)
            return series
        self.leer = lector
        return self.mes_nuevo()

    def test_el_segundo_release_abre_lo_nuevo_y_no_toca_lo_que_no_cambio(self):
        primero = self.publicar(self.candidato(hasta=(2026, 7)))
        segundo = self.publicar(self.candidato(self.mes_nuevo(), hasta=(2026, 8)))
        self.assertEqual((segundo.observaciones_abiertas, segundo.observaciones_cerradas, segundo.observaciones_sin_cambio), (7, 0, 35))
        # Las 35 que no cambiaron conservan su release de origen: no se reescriben.
        self.assertEqual(self.uno("SELECT count(*) FROM observacion WHERE release_desde = %s", (primero.release_numero,)), 35)
        self.assertEqual(self.uno("SELECT count(*) FROM observacion WHERE release_hasta IS NULL"), 42)
        self.assertEqual(self.valor_en("ipc_ng_gba", date(2026, 8, 1), primero.release_numero), None)
        self.assertEqual(self.valor_en("ipc_ng_gba", date(2026, 8, 1), segundo.release_numero), Decimal("105"))

    def test_un_valor_corregido_cierra_la_version_vieja_y_abre_la_nueva(self):
        primero = self.publicar(self.candidato(hasta=(2026, 8)))
        cambio = {("ipc_ng_cuyo", date(2026, 4, 1)): "999"}
        candidato = self.candidato(self.segundo_mes(cambio), hallazgos=[Hallazgo("historia_intacta", "alta", "ipc_ng_cuyo", date(2026, 4, 1), "pasó de 101 a 999")])
        self.aceptar_todos(candidato)
        segundo = self.publicar(candidato)
        self.assertEqual((segundo.observaciones_abiertas, segundo.observaciones_cerradas), (1, 1))
        # La historia es consultable: cada release ve el valor que tenía.
        self.assertEqual(self.valor_en("ipc_ng_cuyo", date(2026, 4, 1), primero.release_numero), Decimal("101"))
        self.assertEqual(self.valor_en("ipc_ng_cuyo", date(2026, 4, 1), segundo.release_numero), Decimal("999"))
        self.assertEqual(self.uno("SELECT release_hasta FROM observacion WHERE serie_id = 'ipc_ng_cuyo' AND periodo = '2026-04-01' AND valor = 101"), segundo.release_numero)

    def test_lo_que_el_candidato_ya_no_trae_deja_de_estar_vigente(self):
        # El release es una foto completa: un mes que desaparece (y alguien aceptó que desapareciera) se cierra.
        primero = self.publicar(self.candidato(hasta=(2026, 8)))
        candidato = self.candidato(self.mes_nuevo(), hallazgos=[Hallazgo("historia_intacta", "alta", None, None, "falta marzo")], desde=(2026, 4))
        self.aceptar_todos(candidato)
        segundo = self.publicar(candidato)
        self.assertEqual((segundo.observaciones_abiertas, segundo.observaciones_cerradas), (0, 7))
        self.assertIsNone(self.valor_en("ipc_ng_gba", date(2026, 3, 1), segundo.release_numero))
        self.assertEqual(self.valor_en("ipc_ng_gba", date(2026, 3, 1), primero.release_numero), Decimal("100"))

    def test_el_mismo_contenido_el_mismo_dia_se_distingue_con_un_numero(self):
        r1 = self.publicar(self.candidato(valor=100))
        self.publicar(self.candidato(self.mes_nuevo(), valor=200))
        otra_vez = self.publicar(self.candidato(self.publicado | {NAC["10"]: xls("nacional-11")}, valor=100))
        self.assertEqual(otra_vez.hash_contenido, r1.hash_contenido)
        self.assertEqual(otra_vez.release_id, r1.release_id + "-2")


class AtomicidadTests(BasePublicacion):
    def test_si_algo_falla_a_mitad_de_la_publicacion_no_queda_nada(self):
        candidato = self.candidato()
        self.conn.execute("CREATE FUNCTION sabotaje() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falla a propósito'; END $$")
        self.conn.execute("CREATE TRIGGER sabotaje BEFORE INSERT ON observacion FOR EACH ROW EXECUTE FUNCTION sabotaje()")
        with self.assertRaises(errors.RaiseException):
            self.publicar(candidato)
        self.nada_publicado()
        self.assertEqual(self.uno("SELECT estado FROM candidato WHERE id = %s", (candidato,)), "abierto")
        # Sacado el problema, el mismo candidato se publica sin rastros del intento anterior.
        self.conn.execute("DROP TRIGGER sabotaje ON observacion")
        publicado = self.publicar(candidato)
        self.assertEqual(self.uno("SELECT count(*) FROM release"), 1)
        # La secuencia avanzó en el intento fallido: el número tiene un hueco, y no importa.
        self.assertEqual(self.uno("SELECT numero FROM release"), publicado.release_numero)


class DescartarTests(BasePublicacion):
    def test_descartar_deja_constancia_y_no_toca_lo_publicado(self):
        self.publicar(self.candidato(hasta=(2026, 7)))
        antes = self.contar("observacion")
        candidato = self.candidato(self.mes_nuevo(), hallazgos=[A])
        publicacion.descartar_candidato(self.conn, candidato, "juani", "El nacional de agosto parece mal cargado")
        fila = self.conn.execute("SELECT estado, decidido_por, motivo FROM candidato WHERE id = %s", (candidato,)).fetchone()
        self.assertEqual(fila, ("descartado", "juani", "El nacional de agosto parece mal cargado"))
        self.assertEqual(self.contar("observacion"), antes)
        self.rechaza("no_abierto", self.publicar, candidato)

    def test_exige_quien_y_por_que_y_que_este_abierto(self):
        candidato = self.candidato()
        self.rechaza("descarte_incompleto", publicacion.descartar_candidato, self.conn, candidato, "juani", "  ")
        self.rechaza("descarte_incompleto", publicacion.descartar_candidato, self.conn, candidato, "", "motivo")
        self.rechaza("no_existe", publicacion.descartar_candidato, self.conn, 99999, "juani", "motivo")
        publicacion.descartar_candidato(self.conn, candidato, "juani", "motivo")
        self.rechaza("no_abierto", publicacion.descartar_candidato, self.conn, candidato, "juani", "otra vez")

    def test_el_reemplazo_automatico_deja_su_motivo(self):
        primero = self.candidato()
        segundo = self.candidato(self.mes_nuevo())
        fila = self.conn.execute("SELECT decidido_por, motivo FROM candidato WHERE id = %s", (primero,)).fetchone()
        self.assertEqual(fila[0], "sistema")
        self.assertIn("Reemplazado por el candidato de la corrida", fila[1])
        self.assertEqual(self.uno("SELECT estado FROM candidato WHERE id = %s", (segundo,)), "abierto")


class LineaDeComandosTests(BasePublicacion):
    def cli(self, *args):
        """Corre `publicar.main` apuntando al schema de la prueba; devuelve (código, salida, errores)."""
        url = f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"
        salida, errores = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            codigo = publicar.main(["--url", url, *args])
        return codigo, salida.getvalue(), errores.getvalue()

    def test_estado_lista_lo_que_falta_resolver(self):
        candidato = self.candidato(hallazgos=[A, B])
        codigo, salida, _ = self.cli("estado", str(candidato))
        self.assertEqual(codigo, 0)
        self.assertIn("sin resolver 2", salida)
        self.assertEqual(salida.count("SIN RESOLVER"), 2)
        self.assertIn("salto_mensual ipc_ng_nacional 2026-03-01", salida)

    def test_aceptar_sin_indicar_hallazgo_acepta_los_que_faltan_y_despues_se_publica(self):
        candidato = self.candidato(hallazgos=[A, B])
        codigo, _, errores = self.cli("publicar", str(candidato), "--por", "juani")
        self.assertEqual(codigo, 1)
        self.assertIn("Faltan 2 hallazgos", errores)
        codigo, salida, _ = self.cli("aceptar", str(candidato), "--por", "juani", "--comentario", "Revisado")
        self.assertEqual((codigo, salida.strip()), (0, "2 hallazgo(s) aceptado(s) por juani"))
        self.assertIn("aceptado por juani", self.cli("estado", str(candidato))[1])
        codigo, salida, _ = self.cli("publicar", str(candidato), "--por", "juani")
        self.assertEqual(codigo, 0)
        self.assertRegex(salida, r"Publicado ipc-\d{4}-\d{2}-\d{2}-[0-9a-f]{10} \(release \d+\): 42 versiones nuevas")
        self.assertEqual(self.uno("SELECT count(*) FROM release"), 1)

    def test_rechazar_pide_el_hallazgo_y_bloquea_la_publicacion(self):
        candidato = self.candidato(hallazgos=[A, B])
        self.assertEqual(self.cli("rechazar", str(candidato), "--por", "juani", "--comentario", "Mal cargado")[0], 1)
        primero = self.hallazgos_de(candidato)[0]
        self.assertEqual(self.cli("aceptar", str(candidato), "--por", "juani", "--comentario", "ok")[0], 0)
        codigo, _, _ = self.cli("rechazar", str(candidato), "--hallazgo", str(primero), "--por", "juani", "--comentario", "Mal cargado")
        self.assertEqual(codigo, 0)
        codigo, _, errores = self.cli("publicar", str(candidato), "--por", "juani")
        self.assertEqual(codigo, 1)
        self.assertIn("1 hallazgo rechazado", errores)

    def test_un_hallazgo_de_otro_candidato_no_se_acepta_y_no_deja_nada_a_medias(self):
        candidato = self.candidato(hallazgos=[A, B])
        propio = self.hallazgos_de(candidato)[0]
        codigo, _, errores = self.cli("aceptar", str(candidato), "--hallazgo", str(propio), "--hallazgo", "99999",
                                      "--por", "juani", "--comentario", "ok")
        self.assertEqual(codigo, 1)
        self.assertIn("99999", errores)
        self.assertEqual(self.contar("revision_hallazgo"), 0)

    def test_descartar_y_los_errores_de_uso(self):
        candidato = self.candidato()
        self.assertEqual(self.cli("descartar", str(candidato), "--por", "juani", "--motivo", "Está mal cargado")[0], 0)
        self.assertEqual(self.uno("SELECT estado FROM candidato WHERE id = %s", (candidato,)), "descartado")
        codigo, _, errores = self.cli("estado", "99999")
        self.assertEqual(codigo, 1)
        self.assertIn("No existe el candidato 99999", errores)
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            self.cli("publicar", str(candidato))  # falta --por


class CicloCompletoTests(BasePublicacion):
    def test_publicar_cierra_el_circuito_con_el_pipeline(self):
        # Primera corrida: hay que revisar los tres hallazgos.
        candidato = self.candidato(hallazgos=[A, B])
        self.aceptar_todos(candidato)
        self.publicar(candidato)

        # El mismo archivo, ya conocido: nada que hacer.
        self.assertEqual(self.correr().estado, "sin_cambios")

        # Archivo nuevo con los mismos datos que lo publicado: tampoco es una novedad.
        self.assertEqual(self.correr(self.mes_nuevo()).estado, "sin_cambios")

        # Llega un mes más: A y B ya se revisaron y no vuelven; solo se revisa lo nuevo.
        self.validar.hallazgos = [A, B, C]
        self.leer.opciones = {"hasta": (2026, 9)}
        resultado = self.correr(self.publicado | {NAC["10"]: xls("nacional-11")})
        self.assertEqual(resultado.estado, "con_candidato", resultado.error)
        self.assertEqual(resultado.hallazgos, (C,))
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (resultado.corrida_id,))
        self.assertEqual((resumen["hallazgos_ya_revisados"], resumen["periodos_nuevos"]), (2, 7))
        self.assertIn("Faltan 1 hallazgo", self.rechaza("hallazgos_pendientes", self.publicar, resultado.candidato_id))
        self.aceptar_todos(resultado.candidato_id)
        self.assertEqual(self.publicar(resultado.candidato_id).observaciones_abiertas, 7)
        self.assertEqual(self.uno("SELECT count(*) FROM release"), 2)


if __name__ == "__main__":
    unittest.main()
