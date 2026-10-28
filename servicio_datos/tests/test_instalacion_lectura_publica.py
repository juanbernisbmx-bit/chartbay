"""Prueba el SQL entregable en un PostgreSQL temporal, sin tocar Supabase.

Requiere initdb, pg_ctl y psql instalados; no usa credenciales ni un servidor
existente. Ejecutar: python -m unittest servicio_datos.tests.test_instalacion_lectura_publica
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SQL_DIR = ROOT / "servicio_datos/despliegue/supabase"
MIGRATIONS = ROOT / "servicio_datos/migraciones"
BINARIES = {name: shutil.which(name) for name in ("initdb", "pg_ctl", "psql")}


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def migration_sql(path):
    body = path.read_text(encoding="utf-8")
    return body + "\nINSERT INTO economia.schema_migrations(version,nombre,checksum) VALUES (" + ",".join(
        literal(value) for value in (path.name[:4], path.name, hashlib.sha256(body.encode()).hexdigest())
    ) + ");\n"


@unittest.skipUnless(all(BINARIES.values()), "Requiere los binarios locales de PostgreSQL")
class InstallationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="chartbay-sql-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.data = cls.directory / "pgdata"
        cls.socket = cls.directory / "socket"
        cls.socket.mkdir(mode=0o700)
        initialized = subprocess.run([BINARIES["initdb"], "-D", str(cls.data), "-U", "chartbay_sql_test",
                                      "--auth=trust", "--no-locale", "-E", "UTF8"],
                                     capture_output=True, text=True)
        if initialized.returncode:
            raise RuntimeError(initialized.stderr)
        with (cls.data / "postgresql.conf").open("a") as out:
            out.write("\nlisten_addresses = ''\nunix_socket_directories = " + literal(str(cls.socket))
                      + "\nport = 55489\nfsync = off\n")
        subprocess.run([BINARIES["pg_ctl"], "-D", str(cls.data), "-l", str(cls.directory / "postgres.log"),
                        "-w", "start"], check=True, capture_output=True, text=True)
        cls.addClassCleanup(cls.stop_server)
        cls.psql("CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; "
                 "CREATE DATABASE chartbay_base_0014;", database="postgres")
        bootstrap = ("BEGIN; CREATE SCHEMA economia; SET LOCAL search_path TO economia, public; "
                     "CREATE TABLE schema_migrations(version text PRIMARY KEY, nombre text NOT NULL, "
                     "checksum text NOT NULL, aplicada_en timestamptz NOT NULL DEFAULT now());\n")
        bootstrap += "\n".join(migration_sql(p) for p in sorted(MIGRATIONS.glob("*.sql")) if p.name[:4] <= "0014")
        cls.psql(bootstrap + "\nCOMMIT;", database="chartbay_base_0014")

    @classmethod
    def stop_server(cls):
        subprocess.run([BINARIES["pg_ctl"], "-D", str(cls.data), "-m", "immediate", "-w", "stop"],
                       check=True, capture_output=True, text=True)

    @classmethod
    def psql(cls, sql, database, check=True):
        result = subprocess.run([BINARIES["psql"], "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                                 "-h", str(cls.socket), "-p", "55489", "-U", "chartbay_sql_test",
                                 "-d", database], input=sql, capture_output=True, text=True)
        if check and result.returncode:
            raise AssertionError(result.stderr)
        return result

    def setUp(self):
        self.database = "t_" + uuid.uuid4().hex[:12]
        self.psql("CREATE DATABASE " + self.database + " TEMPLATE chartbay_base_0014;", database="postgres")

    def tearDown(self):
        self.psql("DROP DATABASE " + self.database + " WITH (FORCE);", database="postgres")

    def run_sql(self, sql, check=True):
        return self.psql(sql, database=self.database, check=check)

    def install(self, check=True):
        return self.run_sql((SQL_DIR / "01_instalar_lectura_publica.sql").read_text(encoding="utf-8"), check=check)

    def scalar(self, sql):
        return self.run_sql(sql).stdout.strip()

    def test_upgrade_from_0014_is_repeatable_and_records_the_original_checksum(self):
        self.run_sql("INSERT INTO economia.fuente(id,nombre) VALUES ('PENDIENTE','Fuente privada');")
        self.install()
        self.run_sql("UPDATE economia.fuente SET licencia='Licencia preservada' WHERE id='PENDIENTE';")
        before = self.scalar("SELECT json_agg(s ORDER BY version)::text FROM economia.schema_migrations s;")
        self.install()
        self.assertEqual(self.scalar("SELECT json_agg(s ORDER BY version)::text FROM economia.schema_migrations s;"), before)
        expected = hashlib.sha256((MIGRATIONS / "0017_exportacion.sql").read_bytes()).hexdigest()
        self.assertEqual(self.scalar("SELECT checksum FROM economia.schema_migrations WHERE version='0017';"), expected)
        self.assertEqual(self.scalar("SELECT count(*) FROM economia.schema_migrations WHERE version IN ('0015','0016');"), "0")
        self.assertEqual(self.scalar("SELECT licencia FROM economia.fuente WHERE id='PENDIENTE';"), "Licencia preservada")
        self.run_sql((SQL_DIR / "02_comprobar_lectura_publica.sql").read_text(encoding="utf-8"))

    def test_public_role_only_receives_licensed_published_data(self):
        self.install()
        self.run_sql("""
            SET search_path TO economia, public;
            INSERT INTO fuente(id,nombre,licencia,atribucion) VALUES
              ('VISIBLE','Fuente publicada','Licencia de prueba','Atribucion de prueba'),
              ('SIN_LICENCIA','Fuente sin licencia',NULL,NULL);
            INSERT INTO serie(id,fuente_id,nombre,frecuencia) VALUES
              ('visible','VISIBLE','Serie publicada','Mensual'),
              ('sin_licencia','SIN_LICENCIA','Serie sin licencia','Mensual');
            WITH co AS (INSERT INTO corrida(fuente_id,estado,terminada_en)
              VALUES ('VISIBLE','con_candidato',now()) RETURNING id),
            ca AS (INSERT INTO candidato(corrida_id,estado,decidido_en,decidido_por)
              SELECT id,'publicado',now(),'prueba' FROM co RETURNING id),
            r AS (INSERT INTO release(release_id,candidato_id,aprobado_por,hash_contenido)
              SELECT 'publicado',id,'prueba',repeat('a',64) FROM ca RETURNING numero)
            INSERT INTO observacion(serie_id,periodo,valor,release_desde)
              SELECT 'visible','2026-01-01',100,numero FROM r;
            WITH co AS (INSERT INTO corrida(fuente_id,estado,terminada_en)
              VALUES ('SIN_LICENCIA','con_candidato',now()) RETURNING id),
            ca AS (INSERT INTO candidato(corrida_id,estado,decidido_en,decidido_por)
              SELECT id,'publicado',now(),'prueba' FROM co RETURNING id),
            r AS (INSERT INTO release(release_id,candidato_id,aprobado_por,hash_contenido)
              SELECT 'sin-licencia',id,'prueba',repeat('b',64) FROM ca RETURNING numero)
            INSERT INTO observacion(serie_id,periodo,valor,release_desde)
              SELECT 'sin_licencia','2026-01-01',200,numero FROM r;
            WITH co AS (INSERT INTO corrida(fuente_id,estado,terminada_en)
              VALUES ('VISIBLE','con_candidato',now()) RETURNING id),
            ca AS (INSERT INTO candidato(corrida_id) SELECT id FROM co RETURNING id)
            INSERT INTO observacion_candidata(candidato_id,serie_id,periodo,valor)
              SELECT id,'visible','2026-01-01',999999 FROM ca;
        """)
        result = self.scalar("SET ROLE anon; SELECT public.catalogo_economico_publicado()::text;")
        payload = json.loads(result)
        self.assertEqual([x["source_id"] for x in payload["sources"]], ["VISIBLE"])
        self.assertEqual(payload["sources"][0]["series"][0]["observations"], [{"date": "2026-01-01", "value": 100}])
        self.assertNotIn("999999", result)
        denied = self.run_sql("SET ROLE anon; SELECT * FROM economia.observacion_candidata;", check=False)
        self.assertNotEqual(denied.returncode, 0)
        self.assertEqual(self.scalar("SELECT has_function_privilege('authenticated', 'public.catalogo_economico_publicado()', 'EXECUTE');"), "t")

    def test_deferred_0015_and_0016_can_be_applied_afterwards(self):
        self.install()
        for name in ("0015_analista_en_sql.sql", "0016_avisos_del_respaldo_en_github.sql"):
            self.run_sql("BEGIN; SET LOCAL search_path TO economia, public;\n" + migration_sql(MIGRATIONS / name) + "COMMIT;")
        self.install()
        self.assertEqual(self.scalar("SELECT count(*) FROM economia.schema_migrations;"), "17")

    def test_checksum_mismatch_is_not_overwritten(self):
        self.install()
        self.run_sql("UPDATE economia.schema_migrations SET checksum='ajeno' WHERE version='0017';")
        result = self.install(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("otro checksum", result.stderr)
        self.assertEqual(self.scalar("SELECT checksum FROM economia.schema_migrations WHERE version='0017';"), "ajeno")

    def test_api_creation_failure_rolls_back_the_migration(self):
        self.run_sql("CREATE FUNCTION public.catalogo_economico_publicado() RETURNS text LANGUAGE sql AS $$ SELECT 'anterior'::text $$;")
        result = self.install(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.scalar("SELECT count(*) FROM economia.schema_migrations WHERE version='0017';"), "0")
        self.assertEqual(self.scalar("SELECT count(*) FROM information_schema.columns WHERE table_schema='economia' AND table_name='fuente' AND column_name='licencia';"), "0")
        self.assertEqual(self.scalar("SELECT public.catalogo_economico_publicado();"), "anterior")


if __name__ == "__main__":
    unittest.main()
