"""El esquema `servicio` y el rol `servicio_datos` (api_servicio.py): lo que pueden hacer las Edge Functions y, sobre todo, lo que no.

Las pruebas llaman como el rol, igual que las Edge Functions en Supabase. Cada prueba tiene su propio rol (los roles son de todo
el servidor, no de un esquema) y lo borra al terminar.
"""
import contextlib
import io

import psycopg
from psycopg import errors
from psycopg.types.json import Jsonb

from servicio_datos import api_servicio, api_revision, carga
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


class BaseServicio(BaseEsquema):
    def setUp(self):
        super().setUp()
        self.api, self.rol = f"{self.schema}_servicio", f"servicio_{self.schema}"
        self.addCleanup(self.aparte, f"DROP SCHEMA IF EXISTS {self.api} CASCADE", f"DROP ROLE IF EXISTS {self.rol}")
        api_servicio.instalar(self.conn, api=self.api, rol=self.rol)

    def aparte(self, *sentencias):
        with psycopg.connect(URL, autocommit=True) as conn:
            for sentencia in sentencias:
                conn.execute(sentencia)

    def como(self, rol=None):
        """Una conexión con los permisos de `rol` (por defecto, el de las Edge Functions)."""
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


class LoQuePuedeTests(BaseServicio):
    def test_hace_una_colecta_entera_solo_con_sus_funciones(self):
        funcion = self.como()
        self.llamar(funcion, "asegurar_fuente", "INDEC_IPC", "INDEC", "https://www.indec.gob.ar")
        corrida = self.llamar(funcion, "abrir_corrida", "INDEC_IPC", 1800.0)
        self.assertIsNone(self.llamar(funcion, "abrir_corrida", "INDEC_IPC", 1800.0))  # ocupada
        self.assertIsNone(funcion.execute(f"SELECT sha256 FROM {self.api}.ultima_descarga(%s)", (URL_NAC,)).fetchone())
        self.llamar(funcion, "registrar_descarga", corrida, URL_NAC, "nueva", SHA, 10, "aa/x.xls", None, None)
        self.llamar(funcion, "anotar_corrida", corrida, Jsonb({"archivos": [{"clave": "nacional", "url": URL_NAC}]}))
        resultado = self.llamar(funcion, "cargar_candidato", corrida, HOY, Jsonb(carga_sintetica()))
        self.assertEqual((resultado["estado"], resultado["periodos_nuevos"]), ("con_candidato", 42))

        estado, resumen = self.conn.execute("SELECT estado, resumen FROM corrida WHERE id = %s", (corrida,)).fetchone()
        self.assertEqual((estado, resumen["archivos"][0]["clave"], resumen["candidato_id"]), ("con_candidato", "nacional", resultado["candidato_id"]))
        self.assertEqual(self.uno("SELECT count(*) FROM release"), 0)  # deja un candidato; publicarlo no es cosa suya

        otra = self.llamar(funcion, "abrir_corrida", "INDEC_IPC", 1800.0)
        self.assertEqual(funcion.execute(f"SELECT sha256, ruta_crudo FROM {self.api}.ultima_descarga(%s)", (URL_NAC,)).fetchone(), (SHA, "aa/x.xls"))
        self.llamar(funcion, "registrar_descarga", otra, URL_NAC, "identica", SHA, 10, "aa/x.xls", None, None)
        self.assertTrue(self.llamar(funcion, "cerrar_corrida", otra, "sin_cambios", None, Jsonb({"archivos": []})))
        self.assertFalse(self.llamar(funcion, "cerrar_corrida", otra, "fallida", "tarde", None))  # ya cerrada: no se toca
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (otra,)), "sin_cambios")

    def test_los_errores_de_negocio_le_llegan_con_su_codigo(self):
        funcion = self.como()
        corrida = self.llamar(funcion, "abrir_corrida", "INDEC_IPC", 1800.0)
        with self.assertRaises(psycopg.Error) as contexto:
            self.llamar(funcion, "cargar_candidato", corrida, HOY, Jsonb({"series": "no"}))
        self.assertEqual((contexto.exception.sqlstate, contexto.exception.diag.message_detail), ("CB001", "carga_invalida"))


class AvisosTests(BaseServicio):
    def test_detecta_toma_y_anota_las_entregas_sin_ver_la_bandeja(self):
        funcion = self.como()
        corrida = self.llamar(funcion, "abrir_corrida", "INDEC_IPC", 1800.0)
        candidato = self.llamar(funcion, "cargar_candidato", corrida, HOY, Jsonb(carga_sintetica()))["candidato_id"]
        self.assertEqual(self.llamar(funcion, "detectar_avisos", HOY, "2026-10-06 15:00+00", 25, 3), 1)
        self.assertEqual(self.llamar(funcion, "detectar_avisos", HOY, "2026-10-06 15:00+00", 25, 3), 0)  # no repite
        tomados = self.llamar(funcion, "tomar_avisos", HOY, 25, 300)
        self.assertEqual((tomados["descartados"], tomados["en_curso"], [a["ruta"] for a in tomados["avisos"]]), (0, 0, [f"/candidatos/{candidato}"]))
        self.assertEqual(self.llamar(funcion, "tomar_avisos", HOY, 25, 300)["en_curso"], 1)  # reservado: no se toma dos veces
        aviso = tomados["avisos"][0]["id"]
        self.assertEqual(self.llamar(funcion, "registrar_entrega", aviso, Jsonb({"slack": {"ok": True}}), True), "enviado")
        self.assertEqual(self.conn.execute("SELECT estado, intentos, entregas FROM aviso").fetchone(), ("enviado", 1, {"slack": {"ok": True}}))
        self.negado(funcion, f"SELECT count(*) FROM {self.schema}.aviso")
        self.negado(funcion, f"UPDATE {self.schema}.aviso SET estado = 'enviado'")


class AnalistaTests(BaseServicio):
    def test_ve_los_hallazgos_con_sus_hechos_y_solo_deja_propuestas_validadas(self):
        funcion = self.como()
        corrida = self.llamar(funcion, "abrir_corrida", "INDEC_IPC", 1800.0)
        self.llamar(funcion, "cargar_candidato", corrida, HOY, Jsonb(carga_sintetica()))
        self.assertEqual(self.llamar(funcion, "proponer_por_precedentes"), 0)
        hallazgos = self.llamar(funcion, "hallazgos_para_el_modelo", 50)
        self.assertEqual(len(hallazgos), 7)  # las siete series sintéticas no arrancan en dic 2016
        primero = hallazgos[0]
        self.assertEqual(primero["pedido"]["hallazgo"]["regla"], "base_referencia")
        self.assertEqual([h["id"] for h in primero["pedido"]["hechos"]], [h["id"] for h in primero["hechos"]])
        self.assertNotIn("etiquetas", primero["pedido"]["hechos"][0])  # el modelo ve los hechos, no cómo los clasifica el validador
        respuesta = {"clasificacion": "cambio_de_base", "accion_sugerida": "investigar", "confianza": "alta", "hechos_citados": [1, 9],
                     "razonamiento": "El primer valor no es 100 en dic 2016."}
        self.assertEqual(self.llamar(funcion, "proponer", primero["hallazgo_id"], Jsonb(respuesta), "claude-de-prueba", Jsonb(primero["hechos"])), "por_modelo")
        fila = self.conn.execute("SELECT tipo, accion_sugerida, confianza, origen, modelo, notas FROM propuesta").fetchone()
        self.assertEqual(fila[:5], ("cambio_de_base", "investigar", "media", "agente", "claude-de-prueba"))  # 1 sola cita válida: media
        self.assertEqual(fila[5], ["Se descartaron citas a hechos que no existen.", "La confianza alta exige al menos dos hechos citados."])
        self.assertEqual(len(self.llamar(funcion, "hallazgos_para_el_modelo", 50)), 6)
        with self.assertRaises(psycopg.Error) as contexto:  # hechos que no son los de la base: no se guarda nada
            self.llamar(funcion, "proponer", hallazgos[1]["hallazgo_id"], Jsonb(respuesta), "claude-de-prueba", Jsonb([{"id": 1, "texto": "inventado", "etiquetas": ["base"]}]))
        self.assertEqual(contexto.exception.diag.message_detail, "hechos_distintos")
        self.negado(funcion, f"INSERT INTO {self.schema}.propuesta (hallazgo_id, tipo, confianza) VALUES ({hallazgos[1]['hallazgo_id']}, 'x', 'alta')")
        self.negado(funcion, f"SELECT {self.schema}.guardar_propuesta(1, 'x', 'alta', 'aceptar', '', '[]', '[]', 'agente', 'x')")


class LoQueNoPuedeTests(BaseServicio):
    def test_no_cierra_una_corrida_como_si_hubiera_dejado_un_candidato(self):
        funcion = self.como()
        corrida = self.llamar(funcion, "abrir_corrida", "INDEC_IPC", 1800.0)
        for estado in ("con_candidato", "en_curso", None):
            with self.subTest(estado=estado), self.assertRaises(psycopg.Error) as contexto:
                self.llamar(funcion, "cerrar_corrida", corrida, estado, None, None)
            self.assertEqual(contexto.exception.diag.message_detail, "estado_no_permitido")
        self.assertEqual(self.uno("SELECT estado FROM corrida WHERE id = %s", (corrida,)), "en_curso")

    def test_no_ve_las_tablas_ni_las_funciones_del_servicio(self):
        funcion = self.como()
        self.negado(funcion, f"SELECT count(*) FROM {self.schema}.observacion")
        self.negado(funcion, f"SELECT count(*) FROM {self.schema}.corrida")
        self.negado(funcion, f"INSERT INTO {self.schema}.release (release_id, candidato_id, aprobado_por, hash_contenido) VALUES ('x', 1, 'x', 'x')")
        self.negado(funcion, f"SELECT * FROM {self.schema}.publicar_candidato(1, 'funcion', 'ipc')")
        self.negado(funcion, f"SELECT {self.schema}.revisar_hallazgo(1, 'aceptado', 'funcion', NULL)")
        self.negado(funcion, f"SELECT {self.schema}.cerrar_corrida(1, 'con_candidato')")

    def test_no_puede_usar_la_api_de_la_revision(self):
        revision = f"{self.schema}_revision"
        self.addCleanup(self.aparte, f"DROP SCHEMA IF EXISTS {revision} CASCADE")
        api_revision.instalar(self.conn, api=revision)
        funcion = self.como()
        self.negado(funcion, f"SELECT {revision}.publicar(1)")
        self.negado(funcion, f"SELECT {revision}.cola()")

    def test_nadie_mas_puede_usar_sus_funciones(self):
        for rol in ("anon", "authenticated", "service_role"):
            self.conn.execute(f"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{rol}') THEN CREATE ROLE {rol} NOLOGIN; END IF; END $$")
        # Lo peor que puede encontrar en Supabase: los roles de su API y permisos por defecto que les dan las funciones nuevas.
        roles_api = "anon, authenticated, service_role"
        self.conn.execute(f"ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO {roles_api}")
        self.addCleanup(self.aparte, f"ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM {roles_api}")
        self.conn.execute(f"DROP SCHEMA {self.api} CASCADE")
        api_servicio.instalar(self.conn, api=self.api, rol=self.rol)
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


class InstalacionTests(BaseServicio):
    def test_cada_funcion_corre_como_quien_la_instalo_con_search_path_fijo(self):
        filas = self.conn.execute("SELECT proname, prosecdef, proconfig FROM pg_proc WHERE pronamespace = %s::regnamespace ORDER BY proname",
                                  (self.api,)).fetchall()
        self.assertEqual([f[0] for f in filas], ["abrir_corrida", "anotar_corrida", "asegurar_fuente", "cargar_candidato", "cerrar_corrida",
                                                 "detectar_avisos", "hallazgos_para_el_modelo", "proponer", "proponer_por_precedentes",
                                                 "registrar_descarga", "registrar_entrega", "tomar_avisos", "ultima_descarga"])
        for nombre, definer, config in filas:
            self.assertEqual((nombre, definer, config), (nombre, True, [f"search_path={self.schema}, pg_temp"]))

    def test_el_rol_nace_sin_poder_iniciar_sesion_y_con_tiempo_limite(self):
        self.assertEqual(self.conn.execute("SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls FROM pg_roles WHERE rolname = %s",
                                           (self.rol,)).fetchone(), (False, False, False, False, False))
        self.assertEqual(self.uno("SELECT setconfig FROM pg_db_role_setting WHERE setrole = %s::regrole AND setdatabase = 0", (self.rol,)),
                         ["statement_timeout=60s"])

    def test_reinstalar_no_rompe_nada_ni_le_quita_el_login_que_le_dieron(self):
        self.conn.execute(f"ALTER ROLE {self.rol} LOGIN")
        api_servicio.instalar(self.conn, api=self.api, rol=self.rol)
        self.assertTrue(self.uno("SELECT rolcanlogin FROM pg_roles WHERE rolname = %s", (self.rol,)))
        self.assertIsNotNone(self.llamar(self.como(), "abrir_corrida", "INDEC_IPC", 1800.0))

    def test_sin_esquema_de_datos_lo_busca_y_valida_los_nombres(self):
        self.assertEqual(api_servicio.instalar(self.conn, api=self.api, rol=self.rol), self.schema)
        for argumentos in ({"datos": "economia; DROP"}, {"api": "Servicio"}, {"rol": "servicio--"}, {"datos": "x", "api": "x"}):
            with self.subTest(**argumentos), self.assertRaises(ValueError):
                api_servicio.sql_api(**argumentos)

    def test_imprime_el_sql_para_el_panel_de_supabase(self):
        salida = io.StringIO()
        with contextlib.redirect_stdout(salida):
            self.assertEqual(api_servicio.main([]), 0)
        sql = salida.getvalue()
        self.assertIn("CREATE OR REPLACE FUNCTION servicio.cargar_candidato", sql)
        self.assertIn("CREATE OR REPLACE FUNCTION servicio.tomar_avisos", sql)
        self.assertIn("SET search_path = economia, pg_temp", sql)
        self.assertIn("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA servicio TO servicio_datos;", sql)
        self.assertNotIn("{", sql)
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(api_servicio.main(["--rol", "Mal"]), 2)
