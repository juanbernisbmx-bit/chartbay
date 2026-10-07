"""El esquema `colecta` y el rol `colector` (api_colecta.py): lo que puede hacer la colecta automática y, sobre todo, lo que no.

Las pruebas llaman como el rol, igual que la Edge Function en Supabase. Cada prueba tiene su propio rol (los roles son de todo
el servidor, no de un esquema) y lo borra al terminar.
"""
import contextlib
import io

import psycopg
from psycopg import errors
from psycopg.types.json import Jsonb

from servicio_datos import api_colecta, api_revision, carga
from servicio_datos.ipc import fuente
from servicio_datos.tests.base import SHA, URL, BaseEsquema
from servicio_datos.tests.test_pipeline import HOY
from servicio_datos.tests.test_pipeline import serie as serie_sintetica

URL_NAC = "https://www.indec.gob.ar/ftp/cuadros/economia/sh_ipc_09_26.xls"


def carga_sintetica():
    series = {}
    for archivo in fuente.archivos(HOY):
        for serie_id in archivo.series.values():
            series[serie_id] = serie_sintetica(serie_id, archivo)
    return carga.carga_de(series, ["nacional", "aperturas"])


class BaseColecta(BaseEsquema):
    def setUp(self):
        super().setUp()
        self.api, self.rol = f"{self.schema}_colecta", f"colector_{self.schema}"
        self.addCleanup(self.aparte, f"DROP SCHEMA IF EXISTS {self.api} CASCADE", f"DROP ROLE IF EXISTS {self.rol}")
        api_colecta.instalar(self.conn, api=self.api, rol=self.rol)

    def aparte(self, *sentencias):
        with psycopg.connect(URL, autocommit=True) as conn:
            for sentencia in sentencias:
                conn.execute(sentencia)

    def como(self, rol=None):
        """Una conexión con los permisos de `rol` (por defecto, el de la colecta)."""
        conn = psycopg.connect(URL, autocommit=True)
        self.addCleanup(conn.close)
        conn.execute(f"SET ROLE {rol or self.rol}")
        return conn

    def llamar(self, conn, funcion, *argumentos):
        marcas = ", ".join(["%s"] * len(argumentos))
        return conn.execute(f"SELECT {self.api}.{funcion}({marcas})", argumentos).fetchone()[0]

    def negado(self, conn, sql, argumentos=()):
        with self.assertRaises(errors.InsufficientPrivilege):
            conn.execute(sql, argumentos)


class LoQuePuedeTests(BaseColecta):
    def test_hace_una_colecta_entera_solo_con_sus_funciones(self):
        colector = self.como()
        self.llamar(colector, "asegurar_fuente", "INDEC_IPC", "INDEC", "https://www.indec.gob.ar")
        corrida = self.llamar(colector, "abrir_corrida", "INDEC_IPC", 1800.0)
        self.assertIsNone(self.llamar(colector, "abrir_corrida", "INDEC_IPC", 1800.0))  # ocupada
        self.assertIsNone(colector.execute(f"SELECT sha256 FROM {self.api}.ultima_descarga(%s)", (URL_NAC,)).fetchone())
        self.llamar(colector, "registrar_descarga", corrida, URL_NAC, "nueva", SHA, 10, "aa/x.xls", None, None)
        self.llamar(colector, "anotar_corrida", corrida, Jsonb({"archivos": [{"clave": "nacional", "url": URL_NAC}]}))
        resultado = self.llamar(colector, "cargar_candidato", corrida, HOY, Jsonb(carga_sintetica()))
        self.assertEqual((resultado["estado"], resultado["periodos_nuevos"]), ("con_candidato", 42))

        estado, resumen = self.conn.execute("SELECT estado, resumen FROM corrida WHERE id = %s", (corrida,)).fetchone()
        self.assertEqual((estado, resumen["archivos"][0]["clave"], resumen["candidato_id"]), ("con_candidato", "nacional", resultado["candidato_id"]))
        self.assertEqual(self.uno("SELECT count(*) FROM release"), 0)  # deja un candidato; publicarlo no es cosa suya

        otra = self.llamar(colector, "abrir_corrida", "INDEC_IPC", 1800.0)
        self.assertEqual(colector.execute(f"SELECT sha256, ruta_crudo FROM {self.api}.ultima_descarga(%s)", (URL_NAC,)).fetchone(), (SHA, "aa/x.xls"))
        self.llamar(colector, "registrar_descarga", otra, URL_NAC, "identica", SHA, 10, "aa/x.xls", None, None)
        self.assertTrue(self.llamar(colector, "cerrar_corrida", otra, "sin_cambios", None, Jsonb({"archivos": []})))
        self.assertFalse(self.llamar(colector, "cerrar_corrida", otra, "fallida", "tarde", None))  # ya cerrada: no se toca
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (otra,)), "sin_cambios")

    def test_los_errores_de_negocio_le_llegan_con_su_codigo(self):
        colector = self.como()
        corrida = self.llamar(colector, "abrir_corrida", "INDEC_IPC", 1800.0)
        with self.assertRaises(psycopg.Error) as contexto:
            self.llamar(colector, "cargar_candidato", corrida, HOY, Jsonb({"series": "no"}))
        self.assertEqual((contexto.exception.sqlstate, contexto.exception.diag.message_detail), ("CB001", "carga_invalida"))


class LoQueNoPuedeTests(BaseColecta):
    def test_no_cierra_una_corrida_como_si_hubiera_dejado_un_candidato(self):
        colector = self.como()
        corrida = self.llamar(colector, "abrir_corrida", "INDEC_IPC", 1800.0)
        for estado in ("con_candidato", "en_curso", None):
            with self.subTest(estado=estado), self.assertRaises(psycopg.Error) as contexto:
                self.llamar(colector, "cerrar_corrida", corrida, estado, None, None)
            self.assertEqual(contexto.exception.diag.message_detail, "estado_no_permitido")
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (corrida,)), "en_curso")

    def test_no_ve_las_tablas_ni_las_funciones_del_servicio(self):
        colector = self.como()
        self.negado(colector, f"SELECT count(*) FROM {self.schema}.observacion")
        self.negado(colector, f"SELECT count(*) FROM {self.schema}.corrida")
        self.negado(colector, f"INSERT INTO {self.schema}.release (release_id, candidato_id, aprobado_por, hash_contenido) VALUES ('x', 1, 'x', 'x')")
        self.negado(colector, f"SELECT * FROM {self.schema}.publicar_candidato(1, 'colector', 'ipc')")
        self.negado(colector, f"SELECT {self.schema}.revisar_hallazgo(1, 'aceptado', 'colector', NULL)")
        self.negado(colector, f"SELECT {self.schema}.cerrar_corrida(1, 'con_candidato')")

    def test_no_puede_usar_la_api_de_la_revision(self):
        revision = f"{self.schema}_revision"
        self.addCleanup(self.aparte, f"DROP SCHEMA IF EXISTS {revision} CASCADE")
        api_revision.instalar(self.conn, api=revision)
        colector = self.como()
        self.negado(colector, f"SELECT {revision}.publicar(1)")
        self.negado(colector, f"SELECT {revision}.cola()")

    def test_nadie_mas_puede_usar_sus_funciones(self):
        for rol in ("anon", "authenticated", "service_role"):
            self.conn.execute(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{rol}') THEN CREATE ROLE {rol} NOLOGIN; END IF; END $$")
        # Lo peor que puede encontrar en Supabase: los roles de su API y permisos por defecto que les dan las funciones nuevas.
        roles_api = "anon, authenticated, service_role"
        self.conn.execute(f"ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO {roles_api}")
        self.addCleanup(self.aparte, f"ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM {roles_api}")
        self.conn.execute(f"DROP SCHEMA {self.api} CASCADE")
        api_colecta.instalar(self.conn, api=self.api, rol=self.rol)
        otro = f"otro_{self.schema}"
        self.conn.execute(f"CREATE ROLE {otro} NOLOGIN")
        self.addCleanup(self.aparte, f"DROP ROLE IF EXISTS {otro}")
        for rol in ("anon", "authenticated", "service_role", otro):
            with self.subTest(rol=rol):
                # Las dos barreras, cada una por su cuenta: ni el esquema ni las funciones.
                self.assertFalse(self.uno("SELECT has_schema_privilege(%s, %s, 'USAGE')", (rol, self.api)))
                self.assertEqual(self.conn.execute(
                    "SELECT p.proname FROM pg_proc p WHERE p.pronamespace = %s::regnamespace AND has_function_privilege(%s, p.oid, 'EXECUTE')",
                    (self.api, rol)).fetchall(), [])
                conn = self.como(rol)
                self.negado(conn, f"SELECT {self.api}.abrir_corrida('INDEC_IPC', 1800)")
                self.negado(conn, f"SELECT {self.api}.cargar_candidato(1, '2026-10-06', '{{}}')")


class InstalacionTests(BaseColecta):
    def test_cada_funcion_corre_como_quien_la_instalo_con_search_path_fijo(self):
        filas = self.conn.execute("SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = %s::regnamespace ORDER BY proname",
                                  (self.api,)).fetchall()
        self.assertEqual([f[0] for f in filas], ["abrir_corrida", "anotar_corrida", "asegurar_fuente", "cargar_candidato", "cerrar_corrida",
                                                 "registrar_descarga", "ultima_descarga"])
        for nombre, definer, config in filas:
            self.assertEqual((nombre, definer, config), (nombre, True, [f"search_path={self.schema}, pg_temp"]))

    def test_el_rol_nace_sin_poder_iniciar_sesion_y_con_tiempo_limite(self):
        self.assertEqual(self.conn.execute("SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = %s",
                                           (self.rol,)).fetchone(), (False, False, False, False, False))
        self.assertEqual(self.uno("SELECT setconfig FROM pg_db_role_setting WHERE setrole = %s::regrole AND setdatabase = 0", (self.rol,)),
                         ["statement_timeout=60s"])

    def test_reinstalar_no_rompe_nada_ni_le_quita_el_login_que_le_dieron(self):
        self.conn.execute(f"ALTER ROLE {self.rol} LOGIN")
        api_colecta.instalar(self.conn, api=self.api, rol=self.rol)
        self.assertTrue(self.uno("SELECT rolcanlogin FROM pg_roles WHERE rolname = %s", (self.rol,)))
        self.assertIsNotNone(self.llamar(self.como(), "abrir_corrida", "INDEC_IPC", 1800.0))

    def test_sin_esquema_de_datos_lo_busca_y_valida_los_nombres(self):
        self.assertEqual(api_colecta.instalar(self.conn, api=self.api, rol=self.rol), self.schema)
        for argumentos in ({"datos": "economia; DROP"}, {"api": "Colecta"}, {"rol": "colector--"}, {"datos": "x", "api": "x"}):
            with self.subTest(**argumentos), self.assertRaises(ValueError):
                api_colecta.sql_api(**argumentos)

    def test_imprime_el_sql_para_el_panel_de_supabase(self):
        salida = io.StringIO()
        with contextlib.redirect_stdout(salida):
            self.assertEqual(api_colecta.main([]), 0)
        sql = salida.getvalue()
        self.assertIn("CREATE OR REPLACE FUNCTION colecta.cargar_candidato", sql)
        self.assertIn("SET search_path = economia, pg_temp", sql)
        self.assertIn("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA colecta TO colector;", sql)
        self.assertNotIn("{", sql)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(api_colecta.main(["--rol", "Mal"]), 2)
