"""Las funciones del servicio resuelven los nombres en su propio esquema, llame quien llame (migración 0013).

La trampa: un esquema adelante en el search_path de quien llama, con una `falla` que no frena nada. Sin el search_path fijo,
`publicar_candidato` la usaría y publicaría con hallazgos pendientes; con él, no.
"""
import psycopg

from servicio_datos.tests.base import URL
from servicio_datos.tests.test_publicacion import A, B, C, BasePublicacion

PUBLICAR = "publicar_candidato(bigint, text, text, date)"


class SearchPathFijoTests(BasePublicacion):
    def setUp(self):
        super().setUp()
        self.trampa = f"{self.schema}_trampa"
        self.conn.execute(f"CREATE SCHEMA {self.trampa}")
        self.addCleanup(self.aparte, f"DROP SCHEMA {self.trampa} CASCADE")
        self.conn.execute(f"CREATE FUNCTION {self.trampa}.falla(codigo text, mensaje text) RETURNS void LANGUAGE sql AS 'SELECT'")

    def aparte(self, sentencia):
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(sentencia)

    def test_ninguna_rutina_queda_sin_search_path_fijo(self):
        filas = self.conn.execute("SELECT p.oid::regprocedure::text, p.proconfig FROM pg_proc p WHERE p.pronamespace = %s::regnamespace",
                                  (self.schema,)).fetchall()
        self.assertGreater(len(filas), 25)
        sueltas = [nombre for nombre, config in filas if config != [f"search_path={self.schema}, pg_temp"]]
        self.assertEqual(sueltas, [])

    def test_un_search_path_ajeno_no_desvia_la_publicacion(self):
        candidato = self.candidato(hallazgos=[A, B, C])
        with psycopg.connect(URL, autocommit=True) as ajena:
            ajena.execute(f"SET search_path TO {self.trampa}, {self.schema}")
            with self.assertRaises(psycopg.Error) as contexto:
                ajena.execute("SELECT * FROM publicar_candidato(%s, 'juani', 'ipc')", (candidato,))
        self.assertEqual(contexto.exception.diag.message_detail, "hallazgos_pendientes")
        self.nada_publicado()

    def test_sin_el_search_path_fijo_la_trampa_funcionaria(self):
        # El control de la prueba de arriba: muestra que la trampa es de verdad. Se deshace todo al final.
        candidato = self.candidato(hallazgos=[A, B, C])
        with psycopg.connect(URL) as conn:
            conn.execute(f"SET LOCAL search_path TO {self.schema}")
            conn.execute(f"ALTER FUNCTION {PUBLICAR} RESET search_path")
            conn.execute(f"SET LOCAL search_path TO {self.trampa}, {self.schema}")
            conn.execute("SELECT * FROM publicar_candidato(%s, 'juani', 'ipc')", (candidato,))
            self.assertEqual(conn.execute(f"SELECT count(*) FROM {self.schema}.release").fetchone()[0], 1)
            conn.rollback()
        self.nada_publicado()
        self.assertEqual(self.uno("SELECT proconfig FROM pg_proc WHERE oid = %s::regprocedure", (PUBLICAR,)),
                         [f"search_path={self.schema}, pg_temp"])

    def test_las_migraciones_que_agreguen_funciones_las_fijan_con_el_procedimiento(self):
        self.conn.execute("CREATE FUNCTION nueva() RETURNS int LANGUAGE sql AS 'SELECT 1'")
        self.conn.execute("CALL fijar_search_path()")
        self.assertEqual(self.uno("SELECT proconfig FROM pg_proc WHERE oid = 'nueva()'::regprocedure"), [f"search_path={self.schema}, pg_temp"])
