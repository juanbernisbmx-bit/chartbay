"""Base común de las pruebas que necesitan PostgreSQL: un schema descartable por test."""
import os
import unittest
import uuid

try:
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None

from servicio_datos import migrar

URL = os.environ.get("DATOS_TEST_DATABASE_URL")
SHA = "a" * 64


@unittest.skipUnless(psycopg and URL, "Falta psycopg o DATOS_TEST_DATABASE_URL")
class BaseEsquema(unittest.TestCase):
    def setUp(self):
        self.schema = "t_" + uuid.uuid4().hex[:12]
        self.conn = psycopg.connect(URL, autocommit=True)
        self.conn.execute(f"CREATE SCHEMA {self.schema}")
        self.conn.execute(f"SET search_path TO {self.schema}, public")
        migrar.aplicar(self.conn)
        self.conn.execute("INSERT INTO fuente (id, nombre) VALUES ('INDEC_IPC', 'INDEC')")
        self.conn.execute(
            "INSERT INTO serie (id, fuente_id, nombre, frecuencia) "
            "VALUES ('ipc_ng_nacional', 'INDEC_IPC', 'IPC nivel general', 'Mensual')"
        )

    def tearDown(self):
        self.conn.execute(f"DROP SCHEMA {self.schema} CASCADE")
        self.conn.close()

    def uno(self, sql, params=()):
        return self.conn.execute(sql, params).fetchone()[0]

    def rechaza(self, excepcion, sql, params=()):
        with self.assertRaises(excepcion):
            self.conn.execute(sql, params)

    def descarga(self, estado="nueva"):
        return self.uno(
            "INSERT INTO descarga (fuente_id, url, sha256, bytes, ruta_crudo, estado) "
            "VALUES ('INDEC_IPC', 'https://www.indec.gob.ar/x.xls', %s, 10, 'crudo/x.xls', %s) RETURNING id",
            (SHA, estado),
        )

    def release(self, nombre):
        """Crea corrida, candidato y release; devuelve el número del release."""
        corrida = self.uno(
            "INSERT INTO corrida (fuente_id, estado, terminada_en) "
            "VALUES ('INDEC_IPC', 'con_candidato', now()) RETURNING id"
        )
        candidato = self.uno(
            "INSERT INTO candidato (corrida_id, estado, decidido_en, decidido_por) "
            "VALUES (%s, 'publicado', now(), 'juani') RETURNING id",
            (corrida,),
        )
        return self.uno(
            "INSERT INTO release (release_id, candidato_id, aprobado_por, hash_contenido) "
            "VALUES (%s, %s, 'juani', %s) RETURNING numero",
            (nombre, candidato, SHA),
        )

    def observacion(self, periodo, valor, desde, hasta=None):
        return self.uno(
            "INSERT INTO observacion (serie_id, periodo, valor, release_desde, release_hasta) "
            "VALUES ('ipc_ng_nacional', %s, %s, %s, %s) RETURNING id",
            (periodo, valor, desde, hasta),
        )
