"""La revisión y la publicación como funciones de la base (migración 0010) y el esquema `revision` que ve ChartBay.

Lo que hace Supabase con una sesión se imita a mano: el rol `authenticated` y el correo en `request.jwt.claims`.
"""
import contextlib
import io
import json
import uuid
from datetime import date
from decimal import Decimal

import psycopg

from servicio_datos import api_revision, publicacion
from servicio_datos.tests.base import URL
from servicio_datos.tests.test_publicacion import A, B, C, BasePublicacion


class FuncionesSqlTests(BasePublicacion):
    def test_el_hash_de_la_base_es_el_de_python(self):
        candidato = self.candidato()
        for mes, valor in enumerate(("101.5859", "1000", "0.50", "100.000", "7"), 1):
            self.conn.execute("INSERT INTO observacion_candidata (candidato_id, serie_id, periodo, valor) VALUES (%s, 'ipc_ng_gba', %s, %s)",
                              (candidato, date(2030, mes, 1), Decimal(valor)))
        filas = self.conn.execute("SELECT serie_id, periodo, valor FROM observacion_candidata WHERE candidato_id = %s", (candidato,)).fetchall()
        self.assertEqual(self.uno("SELECT hash_candidato(%s)", (candidato,)), publicacion.hash_contenido(filas))

    def test_un_error_de_negocio_le_llega_con_su_codigo_a_quien_llama_por_sql(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        with self.assertRaises(psycopg.Error) as contexto:
            self.conn.execute("SELECT * FROM publicar_candidato(%s, 'juani', 'ipc')", (candidato,))
        error = contexto.exception
        self.assertEqual((error.sqlstate, error.diag.message_detail, error.diag.message_primary), ("CB001", "hallazgos_pendientes", "Faltan 3 hallazgos por resolver"))

    def test_las_fechas_de_la_procedencia_se_escriben_como_en_python(self):
        self.assertEqual(self.uno("SELECT iso_utc('2026-09-10 15:52:05-03')"), "2026-09-10T18:52:05+00:00")
        self.assertEqual(self.uno("SELECT iso_utc('2026-09-10 18:52:05.000250+00')"), "2026-09-10T18:52:05.000250+00:00")
        self.assertIsNone(self.uno("SELECT iso_utc(NULL)"))

    def test_aceptar_pendientes_de_una_regla_o_todos(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        self.assertEqual(publicacion.aceptar_pendientes(self.conn, candidato, "juani", regla="salto_mensual"), 1)
        self.assertEqual(publicacion.aceptar_pendientes(self.conn, candidato, "juani", "  "), 2)
        self.assertEqual(publicacion.aceptar_pendientes(self.conn, candidato, "juani"), 0)
        self.assertEqual({c for (c,) in self.conn.execute("SELECT comentario FROM revision_hallazgo")}, {"Revisado"})
        self.assertEqual(self.publicar(candidato).observaciones_abiertas, 42)

    def test_aceptar_pendientes_de_un_candidato_que_no_existe(self):
        self.assertEqual(self.rechaza("no_existe", publicacion.aceptar_pendientes, self.conn, 99999, "juani"), "No existe el candidato 99999")


class BaseApi(BasePublicacion):
    def setUp(self):
        super().setUp()
        self.conn.execute("DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF; END $$")
        self.api = f"{self.schema}_api"
        api_revision.instalar(self.conn, api=self.api)
        self.addCleanup(self.aparte, f"DROP SCHEMA IF EXISTS {self.api} CASCADE")
        self.conn.execute("INSERT INTO revisor (email, nombre) VALUES ('juani@club.org', 'Juani'), ('ex@club.org', 'Ex revisora')")
        self.conn.execute("UPDATE revisor SET activo = false WHERE email = 'ex@club.org'")

    def aparte(self, sentencia):
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(sentencia)

    def sesion(self, email="juani@club.org", rol="authenticated"):
        """Una conexión como la que arma Supabase para una sesión: con el rol y, si hay, el correo en los claims."""
        conn = psycopg.connect(URL, autocommit=True)
        self.addCleanup(conn.close)
        conn.execute(f"SET ROLE {rol}")
        if email is not None:
            conn.execute("SELECT set_config('request.jwt.claims', %s, false)", (json.dumps({"email": email, "role": rol}),))
        return conn

    def llamar(self, conn, funcion, *argumentos):
        marcas = ", ".join(["%s"] * len(argumentos))
        return conn.execute(f"SELECT {self.api}.{funcion}({marcas})", argumentos).fetchone()[0]


class AutorizacionTests(BaseApi):
    def test_un_revisor_de_la_lista_revisa_con_el_nombre_de_la_lista(self):
        candidato = self.candidato(hallazgos=[A])
        (hallazgo,) = self.hallazgos_de(candidato)
        self.llamar(self.sesion("JUANI@club.org"), "revisar", hallazgo, "aceptado", "ok")
        self.assertEqual(self.conn.execute("SELECT decision, revisor, comentario FROM revision_hallazgo").fetchone(), ("aceptado", "Juani", "ok"))

    def test_sin_sesion_o_sin_ser_revisor_activo_no_se_puede_nada(self):
        candidato = self.candidato(hallazgos=[A])
        (hallazgo,) = self.hallazgos_de(candidato)
        acciones = (("revisar", hallazgo, "aceptado", "ok"), ("aceptar_pendientes", candidato), ("publicar", candidato), ("descartar", candidato, "x"),
                    ("cola",), ("candidato", candidato), ("series", candidato, []))
        for email in (None, "otra@club.org", "ex@club.org"):
            conn = self.sesion(email)
            for funcion, *argumentos in acciones:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege, msg=(email, funcion)) as contexto:
                    self.llamar(conn, funcion, *argumentos)
                self.assertEqual(contexto.exception.diag.message_detail, "no_autorizado", (email, funcion))
        self.assertEqual((self.contar("revision_hallazgo"), self.uno("SELECT estado FROM candidato WHERE id = %s", (candidato,))), (0, "abierto"))

    def test_sin_iniciar_sesion_ni_siquiera_se_llega_a_las_funciones(self):
        conn = self.sesion("juani@club.org", rol="anon")
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.llamar(conn, "cola")

    def test_una_sesion_no_ve_las_tablas_ni_las_funciones_internas(self):
        conn = self.sesion()
        for consulta in (f"SELECT * FROM {self.schema}.candidato", f"SELECT {self.schema}.estado_revision(1)", f"SELECT * FROM {self.schema}.revisor"):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege, msg=consulta):
                conn.execute(consulta)

    def test_todas_las_funciones_corren_con_un_search_path_fijo(self):
        funciones = self.conn.execute(
            "SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = %s", (self.api,)).fetchall()
        self.assertEqual({f[0] for f in funciones}, {"revisor_actual", "exigir_revisor", "revisar", "aceptar_pendientes", "publicar", "descartar", "cola", "candidato", "series"})
        for nombre, definer, config in funciones:
            self.assertTrue(definer, nombre)
            self.assertIn(f"search_path={self.schema}, pg_temp", config, nombre)


class AccionesTests(BaseApi):
    def test_aceptar_publicar_y_descartar(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        conn = self.sesion()
        self.assertEqual(self.llamar(conn, "aceptar_pendientes", candidato), 3)
        resultado = self.llamar(conn, "publicar", candidato)
        self.assertTrue(resultado["release_id"].startswith("ipc-"))
        self.assertEqual(resultado["observaciones_abiertas"], 42)
        self.assertEqual(self.uno("SELECT aprobado_por FROM release WHERE release_id = %s", (resultado["release_id"],)), "Juani")
        otro = self.candidato(self.mes_nuevo(), hallazgos=[A], valor=200)
        self.llamar(conn, "descartar", otro, "No me convence")
        self.assertEqual(self.conn.execute("SELECT estado, decidido_por, motivo FROM candidato WHERE id = %s", (otro,)).fetchone(),
                         ("descartado", "Juani", "No me convence"))

    def test_los_errores_de_negocio_llegan_con_su_codigo(self):
        candidato = self.candidato(hallazgos=[A, B])
        conn = self.sesion()
        casos = ((("publicar", candidato), "hallazgos_pendientes"), (("revisar", self.hallazgos_de(candidato)[0], "rechazado", None), "revision_invalida"),
                 (("descartar", candidato, " "), "descarte_incompleto"), (("candidato", 99999), "no_existe"))
        for (funcion, *argumentos), codigo in casos:
            with self.assertRaises(psycopg.Error, msg=funcion) as contexto:
                self.llamar(conn, funcion, *argumentos)
            self.assertEqual((contexto.exception.sqlstate, contexto.exception.diag.message_detail), ("CB001", codigo), funcion)


class LecturasTests(BaseApi):
    def test_la_cola(self):
        abierto = self.candidato(hallazgos=[A, B])
        self.conn.execute("INSERT INTO propuesta (hallazgo_id, tipo, confianza, accion_sugerida, evidencia) VALUES (%s, 'dato_real', 'alta', 'aceptar', '[1] x')",
                          (self.hallazgos_de(abierto)[0],))
        cola = self.llamar(self.sesion(), "cola")
        self.assertEqual(cola["revisor"], "Juani")
        ((fila,),) = (cola["abiertos"],)
        self.assertEqual((fila["id"], fila["hallazgos"], fila["pendientes"], fila["propuestas_pendientes"]), (abierto, 2, 2, 1))
        self.assertEqual((cola["fallidas"], cola["historial"], cola["release"]), ([], [], None))

    def test_un_candidato_con_sus_hallazgos_propuestas_y_diferencias(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        hallazgo = self.hallazgos_de(candidato)[0]
        self.conn.execute("INSERT INTO propuesta (hallazgo_id, tipo, confianza, accion_sugerida, evidencia, razonamiento) "
                          "VALUES (%s, 'dato_real', 'alta', 'aceptar', '[1] x', 'Se ve en todas las series.')", (hallazgo,))
        publicacion.revisar_hallazgo(self.conn, hallazgo, "aceptado", "juani", "ok")
        detalle = self.llamar(self.sesion(), "candidato", candidato)
        self.assertEqual((detalle["candidato"]["id"], detalle["candidato"]["fuente_id"], detalle["candidato"]["estado"]), (candidato, "INDEC_IPC", "abierto"))
        self.assertEqual((detalle["estado"]["total"], detalle["estado"]["aceptados"], detalle["estado"]["pendientes"]), (3, 1, 2))
        self.assertEqual([a["archivo"] for a in detalle["archivos"]], ["sh_ipc_09_26.xls", "sh_ipc_aperturas.xls"])
        self.assertIn("http_last_modified", detalle["archivos"][0])
        primero = detalle["hallazgos"][0]
        self.assertEqual((primero["regla"], primero["decision"], primero["revisor"]), ("salto_mensual", "aceptado", "juani"))
        self.assertEqual((primero["propuestas"][0]["razonamiento"], primero["propuestas"][0]["estado"]), ("Se ve en todas las series.", "aprobada"))
        self.assertEqual((detalle["diferencias"]["nuevos"], detalle["diferencias"]["total"], len(detalle["diferencias"]["filas"])), (42, 42, 40))

    def test_las_series_para_los_graficos(self):
        candidato = self.candidato()
        series = self.llamar(self.sesion(), "series", candidato, ["ipc_ng_gba", "no_existe"])
        self.assertEqual(len(series["ipc_ng_gba"]["candidato"]), 6)
        self.assertEqual(series["ipc_ng_gba"]["candidato"][0], ["2026-03-01", 100])
        self.assertEqual((series["ipc_ng_gba"]["vigente"], series["no_existe"]), ([], {"candidato": [], "vigente": []}))


class InstalacionTests(BaseApi):
    def test_se_puede_volver_a_instalar(self):
        api_revision.instalar(self.conn, api=self.api)
        self.assertEqual(self.llamar(self.sesion(), "cola")["revisor"], "Juani")

    def test_el_sql_para_el_panel(self):
        salida = io.StringIO()
        with contextlib.redirect_stdout(salida):
            self.assertEqual(api_revision.main([]), 0)
        texto = salida.getvalue()
        self.assertIn("CREATE OR REPLACE FUNCTION revision.publicar(candidato_id bigint)", texto)
        self.assertIn("SET search_path = economia, pg_temp", texto)
        self.assertNotIn("{api}", texto)
        for datos, api in (("economia", "economia"), ("Economia", "revision"), ("economia", "revision; DROP")):
            with self.assertRaises(ValueError):
                api_revision.sql_api(datos, api)

    def test_sin_esquema_del_servicio_no_instala(self):
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(f"SET search_path TO nada_{uuid.uuid4().hex[:6]}")
            with self.assertRaisesRegex(ValueError, "schema_migrations"):
                api_revision.instalar(conn, api=self.api + "_x")
