"""Esquema de PostgreSQL: invariantes que la base misma tiene que sostener.

Necesita un PostgreSQL de prueba. Sin DATOS_TEST_DATABASE_URL los tests se
saltean. Cada test crea su propio schema y lo borra al terminar.

    DATOS_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres \\
        python -m unittest servicio_datos.tests.test_esquema
"""
import os
import shutil
import tempfile
import unittest
import uuid
from decimal import Decimal
from pathlib import Path

try:
    import psycopg
    from psycopg import errors
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


class MigradorTests(BaseEsquema):
    def test_es_idempotente(self):
        self.assertEqual(migrar.aplicar(self.conn), [])
        self.assertEqual(self.uno("SELECT count(*) FROM schema_migrations"), 1)

    def test_migracion_ya_aplicada_no_se_puede_editar(self):
        carpeta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, carpeta)
        origen = migrar.MIGRACIONES / "0001_esquema_inicial.sql"
        (carpeta / origen.name).write_text(origen.read_text(encoding="utf-8") + "\n-- editada\n", encoding="utf-8")
        with self.assertRaises(migrar.ErrorMigracion):
            migrar.aplicar(self.conn, carpeta)

    def test_rechaza_nombres_y_numeros_duplicados(self):
        carpeta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, carpeta)
        (carpeta / "esquema.sql").write_text("SELECT 1", encoding="utf-8")
        with self.assertRaises(migrar.ErrorMigracion):
            migrar.aplicar(self.conn, carpeta)
        (carpeta / "esquema.sql").unlink()
        (carpeta / "0001_a.sql").write_text("SELECT 1", encoding="utf-8")
        (carpeta / "0001_b.sql").write_text("SELECT 1", encoding="utf-8")
        with self.assertRaises(migrar.ErrorMigracion):
            migrar.aplicar(self.conn, carpeta)

    def test_migracion_fallida_no_deja_registro_ni_cambios(self):
        carpeta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, carpeta)
        origen = migrar.MIGRACIONES / "0001_esquema_inicial.sql"
        (carpeta / origen.name).write_text(origen.read_text(encoding="utf-8"), encoding="utf-8")
        (carpeta / "0002_rota.sql").write_text(
            "CREATE TABLE nueva_tabla (id int); SELECT 1/0;", encoding="utf-8"
        )
        with self.assertRaises(errors.DivisionByZero):
            migrar.aplicar(self.conn, carpeta)
        self.assertEqual(self.uno("SELECT count(*) FROM schema_migrations"), 1)
        self.assertIsNone(self.uno("SELECT to_regclass('nueva_tabla')"))


class CrudoTests(BaseEsquema):
    def test_descarga_lograda_exige_archivo_y_hash(self):
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO descarga (fuente_id, url, estado) VALUES ('INDEC_IPC', 'u', 'nueva')",
        )
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO descarga (fuente_id, url, sha256, bytes, ruta_crudo, estado) "
            "VALUES ('INDEC_IPC', 'u', 'no-es-un-hash', 1, 'r', 'nueva')",
        )

    def test_descarga_fallida_exige_motivo(self):
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO descarga (fuente_id, url, estado) VALUES ('INDEC_IPC', 'u', 'fallida')",
        )
        self.conn.execute(
            "INSERT INTO descarga (fuente_id, url, estado, error) "
            "VALUES ('INDEC_IPC', 'u', 'fallida', 'HTTP 404')"
        )

    def test_crudo_es_de_solo_agregar(self):
        descarga = self.descarga()
        for sql in (
            "UPDATE descarga SET sha256 = %s WHERE id = %s",
            "DELETE FROM descarga WHERE id = %s",
        ):
            params = ("b" * 64, descarga) if sql.startswith("UPDATE") else (descarga,)
            with self.assertRaises(errors.RaiseException):
                self.conn.execute(sql, params)
        self.rechaza(errors.RaiseException, "TRUNCATE descarga CASCADE")
        self.assertEqual(self.uno("SELECT sha256 FROM descarga WHERE id = %s", (descarga,)), SHA)

    def test_corrida_estado_coherente(self):
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO corrida (fuente_id, estado, terminada_en) VALUES ('INDEC_IPC', 'fallida', now())",
        )
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO corrida (fuente_id, estado) VALUES ('INDEC_IPC', 'sin_cambios')",
        )
        self.conn.execute("INSERT INTO corrida (fuente_id, estado) VALUES ('INDEC_IPC', 'en_curso')")


class ObservacionTests(BaseEsquema):
    def test_conserva_la_precision_del_valor(self):
        r1 = self.release("ipc-1")
        self.observacion("2017-01-01", Decimal("101.5859"), r1)
        self.assertEqual(self.uno("SELECT valor FROM observacion"), Decimal("101.5859"))

    def test_faltante_no_se_guarda_como_nulo(self):
        r1 = self.release("ipc-1")
        self.rechaza(
            errors.NotNullViolation,
            "INSERT INTO observacion (serie_id, periodo, valor, release_desde) "
            "VALUES ('ipc_ng_nacional', '2017-01-01', NULL, %s)",
            (r1,),
        )

    def test_versiones_y_consulta_a_un_release(self):
        r1 = self.release("ipc-1")
        r2 = self.release("ipc-2")
        vieja = self.observacion("2017-01-01", 100, r1)
        self.conn.execute("UPDATE observacion SET release_hasta = %s WHERE id = %s", (r2, vieja))
        self.observacion("2017-01-01", 101, r2)

        def valor_en(numero):
            return self.uno(
                "SELECT valor FROM observacion WHERE periodo = '2017-01-01' "
                "AND release_desde <= %s AND (release_hasta IS NULL OR release_hasta > %s)",
                (numero, numero),
            )

        self.assertEqual(valor_en(r1), 100)
        self.assertEqual(valor_en(r2), 101)
        self.assertEqual(self.uno("SELECT valor FROM observacion_vigente"), 101)
        self.assertEqual(self.uno("SELECT count(*) FROM observacion"), 2)

    def test_dos_versiones_vigentes_a_la_vez_se_rechazan(self):
        r1 = self.release("ipc-1")
        r2 = self.release("ipc-2")
        self.observacion("2017-01-01", 100, r1)
        self.rechaza(
            errors.ExclusionViolation,
            "INSERT INTO observacion (serie_id, periodo, valor, release_desde) "
            "VALUES ('ipc_ng_nacional', '2017-01-01', 101, %s)",
            (r2,),
        )

    def test_rango_invertido_se_rechaza(self):
        r1 = self.release("ipc-1")
        r2 = self.release("ipc-2")
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO observacion (serie_id, periodo, valor, release_desde, release_hasta) "
            "VALUES ('ipc_ng_nacional', '2017-01-01', 100, %s, %s)",
            (r2, r1),
        )

    def test_solo_se_puede_cerrar_nunca_corregir_o_borrar(self):
        r1 = self.release("ipc-1")
        r2 = self.release("ipc-2")
        obs = self.observacion("2017-01-01", 100, r1)
        self.rechaza(errors.RaiseException, "UPDATE observacion SET valor = 999 WHERE id = %s", (obs,))
        self.rechaza(
            errors.RaiseException,
            "UPDATE observacion SET valor = 999, release_hasta = %s WHERE id = %s",
            (r2, obs),
        )
        self.rechaza(errors.RaiseException, "DELETE FROM observacion WHERE id = %s", (obs,))
        self.rechaza(errors.RaiseException, "TRUNCATE observacion")
        self.conn.execute("UPDATE observacion SET release_hasta = %s WHERE id = %s", (r2, obs))
        self.rechaza(errors.RaiseException, "UPDATE observacion SET release_hasta = NULL WHERE id = %s", (obs,))
        self.assertEqual(self.uno("SELECT valor FROM observacion WHERE id = %s", (obs,)), 100)

    def test_identificador_de_serie_con_formato(self):
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO serie (id, fuente_id, nombre, frecuencia) "
            "VALUES ('IPC Nacional', 'INDEC_IPC', 'x', 'Mensual')",
        )


class PropuestaTests(BaseEsquema):
    def propuesta(self):
        corrida = self.uno(
            "INSERT INTO corrida (fuente_id, estado, terminada_en) "
            "VALUES ('INDEC_IPC', 'con_candidato', now()) RETURNING id"
        )
        hallazgo = self.uno(
            "INSERT INTO hallazgo (corrida_id, regla, severidad) VALUES (%s, 'cobertura', 'media') RETURNING id",
            (corrida,),
        )
        return self.uno(
            "INSERT INTO propuesta (hallazgo_id, tipo, confianza) VALUES (%s, 'nota', 'media') RETURNING id",
            (hallazgo,),
        )

    def test_aprobar_exige_evidencia(self):
        p = self.propuesta()
        self.rechaza(
            errors.CheckViolation,
            "UPDATE propuesta SET estado = 'aprobada', revisor = 'juani', decidida_en = now() WHERE id = %s",
            (p,),
        )
        self.rechaza(
            errors.CheckViolation,
            "UPDATE propuesta SET estado = 'aprobada', revisor = 'juani', decidida_en = now(), "
            "evidencia = '   ' WHERE id = %s",
            (p,),
        )
        self.conn.execute(
            "UPDATE propuesta SET estado = 'aprobada', revisor = 'juani', decidida_en = now(), "
            "evidencia = 'Nota metodológica, hoja 2' WHERE id = %s",
            (p,),
        )

    def test_rechazar_exige_comentario(self):
        p = self.propuesta()
        self.rechaza(
            errors.CheckViolation,
            "UPDATE propuesta SET estado = 'rechazada', revisor = 'juani', decidida_en = now() WHERE id = %s",
            (p,),
        )
        self.conn.execute(
            "UPDATE propuesta SET estado = 'rechazada', revisor = 'juani', decidida_en = now(), "
            "comentario = 'El valor es correcto' WHERE id = %s",
            (p,),
        )

    def test_decision_exige_revisor_y_fecha(self):
        p = self.propuesta()
        self.rechaza(
            errors.CheckViolation,
            "UPDATE propuesta SET estado = 'rechazada', comentario = 'x' WHERE id = %s",
            (p,),
        )

    def test_propuesta_decidida_no_se_toca(self):
        p = self.propuesta()
        self.conn.execute(
            "UPDATE propuesta SET estado = 'rechazada', revisor = 'juani', decidida_en = now(), "
            "comentario = 'no' WHERE id = %s",
            (p,),
        )
        self.rechaza(errors.RaiseException, "UPDATE propuesta SET comentario = 'otro' WHERE id = %s", (p,))
        self.rechaza(errors.RaiseException, "DELETE FROM propuesta WHERE id = %s", (p,))
        self.rechaza(errors.RaiseException, "TRUNCATE propuesta")


class ReleaseTests(BaseEsquema):
    def test_release_es_de_solo_agregar(self):
        r1 = self.release("ipc-1")
        self.rechaza(errors.RaiseException, "UPDATE release SET aprobado_por = 'otro' WHERE numero = %s", (r1,))
        self.rechaza(errors.RaiseException, "DELETE FROM release WHERE numero = %s", (r1,))
        self.rechaza(errors.RaiseException, "TRUNCATE release CASCADE")

    def test_release_id_y_candidato_son_unicos(self):
        self.release("ipc-1")
        with self.assertRaises(errors.UniqueViolation):
            self.release("ipc-1")

    def test_candidato_decidido_exige_quien_y_cuando(self):
        corrida = self.uno(
            "INSERT INTO corrida (fuente_id, estado, terminada_en) "
            "VALUES ('INDEC_IPC', 'con_candidato', now()) RETURNING id"
        )
        self.rechaza(
            errors.CheckViolation,
            "INSERT INTO candidato (corrida_id, estado) VALUES (%s, 'publicado')",
            (corrida,),
        )


if __name__ == "__main__":
    unittest.main()
