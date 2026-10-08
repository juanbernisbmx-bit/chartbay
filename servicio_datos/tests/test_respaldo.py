"""Respaldo de la base y del crudo: copia y verificación del crudo, conservación, volcado con pg_dump, ensayo de restauración
y la línea de comandos. Lo que usa pg_dump necesita PostgreSQL y sus programas (DATOS_PG_BIN o el PATH)."""
import contextlib
import io
import json
import os
import shutil
import stat
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from servicio_datos import respaldar, respaldo
from servicio_datos.crudo import AlmacenCrudo
from servicio_datos.respaldo import ErrorRespaldo
from servicio_datos.tests.base import URL, BaseEsquema

try:
    import psycopg
    from psycopg.conninfo import make_conninfo
except ImportError:  # pragma: no cover
    psycopg = None

PG_BIN = os.environ.get("DATOS_PG_BIN")
HAY_PG_DUMP = bool(shutil.which("pg_dump", path=PG_BIN) if PG_BIN else shutil.which("pg_dump"))
AHORA = datetime(2026, 10, 7, 6, 15, tzinfo=timezone.utc)


class Carpetas(unittest.TestCase):
    def carpeta(self):
        ruta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, ruta, ignore_errors=True)
        return ruta

    def danar(self, ruta, contenido=b"basura"):
        ruta.chmod(0o644)
        ruta.write_bytes(contenido)


class EntornoLibpqTests(unittest.TestCase):
    def test_cada_parametro_va_a_su_variable_y_la_clave_tambien(self):
        entorno = respaldo.entorno_libpq("postgresql://datos_respaldo.ref:cl%40ve@pooler.example.com:5432/postgres?sslmode=require&connect_timeout=10")
        self.assertEqual(entorno, {"PGUSER": "datos_respaldo.ref", "PGPASSWORD": "cl@ve", "PGHOST": "pooler.example.com", "PGPORT": "5432",
                                   "PGDATABASE": "postgres", "PGSSLMODE": "require", "PGCONNECT_TIMEOUT": "10"})

    def test_lo_que_no_sabe_pasar_lo_rechaza_en_vez_de_perderlo(self):
        with self.assertRaisesRegex(ErrorRespaldo, "service"):
            respaldo.entorno_libpq("postgresql://u@h/db?service=algo")

    def test_una_url_rota_no_se_repite_en_el_error(self):
        with self.assertRaises(ErrorRespaldo) as contexto:
            respaldo.entorno_libpq("postgresql://u:secreto@h/db?parametro_inventado=1")
        self.assertNotIn("secreto", str(contexto.exception))


class CrudoTests(Carpetas):
    def setUp(self):
        self.origen, self.destino = self.carpeta(), self.carpeta() / "crudo"
        self.almacen = AlmacenCrudo(self.origen)

    def guardar(self, contenido):
        return self.almacen.guardar(contenido)[1]

    def test_copia_lo_nuevo_tal_cual_y_de_solo_lectura(self):
        a, b = self.guardar(b"nacional"), self.guardar(b"aperturas")
        resultado = respaldo.respaldar_crudo(self.origen, self.destino)
        self.assertEqual((resultado.archivos, resultado.copiados, resultado.ok), (2, 2, True))
        for relativa, contenido in ((a, b"nacional"), (b, b"aperturas")):
            self.assertEqual((self.destino / relativa).read_bytes(), contenido)
            self.assertEqual(stat.S_IMODE((self.destino / relativa).stat().st_mode), 0o444)

    def test_repetirlo_no_copia_de_nuevo(self):
        self.guardar(b"nacional")
        respaldo.respaldar_crudo(self.origen, self.destino)
        self.assertEqual(respaldo.respaldar_crudo(self.origen, self.destino).copiados, 0)

    def test_ignora_temporales_y_archivos_ajenos(self):
        self.guardar(b"nacional")
        (self.origen / "ab").mkdir(exist_ok=True)
        (self.origen / "ab" / "x.tmp").write_bytes(b"a medias")
        (self.origen / "notas.txt").write_text("hola")
        (self.origen / "cd").mkdir()
        (self.origen / "cd" / ("ab" + "0" * 62 + ".xls")).write_bytes(b"prefijo que no coincide")
        self.assertEqual(respaldo.respaldar_crudo(self.origen, self.destino).archivos, 1)
        self.assertEqual(len(list(self.destino.rglob("*.*"))), 1)

    def test_una_copia_danada_se_repone(self):
        relativa = self.guardar(b"nacional")
        respaldo.respaldar_crudo(self.origen, self.destino)
        self.danar(self.destino / relativa)
        resultado = respaldo.respaldar_crudo(self.origen, self.destino)
        self.assertEqual((resultado.reparados, resultado.ok), (1, True))
        self.assertEqual((self.destino / relativa).read_bytes(), b"nacional")

    def test_un_original_danado_se_informa_y_no_pisa_la_copia_buena(self):
        relativa = self.guardar(b"nacional")
        respaldo.respaldar_crudo(self.origen, self.destino)
        self.danar(self.origen / relativa)
        resultado = respaldo.respaldar_crudo(self.origen, self.destino)
        self.assertEqual((resultado.danados_origen, resultado.ok), ([relativa], False))
        self.assertEqual((self.destino / relativa).read_bytes(), b"nacional")

    def test_un_original_danado_sin_copia_no_se_copia(self):
        relativa = self.guardar(b"nacional")
        self.danar(self.origen / relativa)
        self.assertEqual(respaldo.respaldar_crudo(self.origen, self.destino).copiados, 0)
        self.assertFalse((self.destino / relativa).exists())

    def test_lo_que_la_base_nombra_y_falta_se_informa_y_la_copia_nunca_se_borra(self):
        guardado, perdido = self.guardar(b"nacional"), "ab/ab" + "1" * 62 + ".xls"
        respaldo.respaldar_crudo(self.origen, self.destino)
        (self.origen / guardado).unlink()
        resultado = respaldo.respaldar_crudo(self.origen, self.destino, esperados=[guardado, perdido])
        self.assertEqual((resultado.faltan_en_origen, resultado.perdidos, resultado.ok), ([guardado], [perdido], False))
        self.assertTrue((self.destino / guardado).exists())

    def test_sin_carpeta_de_crudo_falla(self):
        with self.assertRaisesRegex(ErrorRespaldo, "No existe la carpeta del crudo"):
            respaldo.respaldar_crudo(self.origen / "no-esta", self.destino)

    def test_restaurar_devuelve_lo_que_falta_o_esta_danado_y_no_usa_copias_danadas(self):
        falta, danado, intacto, copia_mala = (self.guardar(c) for c in (b"uno", b"dos", b"tres", b"cuatro"))
        respaldo.respaldar_crudo(self.origen, self.destino)
        (self.origen / falta).unlink()
        self.danar(self.origen / danado)
        (self.origen / copia_mala).unlink()
        self.danar(self.destino / copia_mala)
        resultado = respaldo.restaurar_crudo(self.destino, self.origen)
        self.assertEqual((sorted(resultado["restaurados"]), resultado["ya_estaban"], resultado["danados_en_la_copia"]), (sorted([falta, danado]), 1, [copia_mala]))
        self.assertEqual(((self.origen / falta).read_bytes(), (self.origen / danado).read_bytes()), (b"uno", b"dos"))
        self.assertFalse((self.origen / copia_mala).exists())
        self.assertEqual((self.origen / intacto).read_bytes(), b"tres")


class PodarTests(Carpetas):
    def volcado(self, carpeta, momento, manifiesto=True):
        nombre = f"economia-{momento:%Y%m%dT%H%M%SZ}"
        (carpeta / f"{nombre}.dump").write_bytes(b"x")
        if manifiesto:
            (carpeta / f"{nombre}.json").write_text("{}")
        return nombre

    def nombres(self, carpeta):
        return sorted(p.stem for p in carpeta.glob("*.dump"))

    def test_conserva_los_recientes_y_de_los_viejos_el_primero_de_cada_mes(self):
        carpeta = self.carpeta()
        diarios = [self.volcado(carpeta, AHORA - timedelta(days=d)) for d in range(0, 90)]
        borrados = respaldo.podar(carpeta, AHORA, dias=30)
        quedan = self.nombres(carpeta)
        # Del 7 de octubre hacia atrás: los 31 de los últimos 30 días, y de lo anterior el primero de septiembre, de agosto y
        # de julio (el 10, el más viejo que hay).
        self.assertEqual(quedan, sorted(diarios[:31] + ["economia-20260901T061500Z", "economia-20260801T061500Z", "economia-20260710T061500Z"]))
        self.assertEqual(len(borrados), 90 - 34)  # se informa el volcado; su manifiesto se va con él
        self.assertEqual(sorted(p.stem for p in carpeta.glob("*.json")), quedan)

    def test_nunca_borra_el_ultimo_bueno_aunque_sea_viejo(self):
        # Si el respaldo dejó de andar hace meses, lo último que salió bien es lo más valioso que hay.
        carpeta = self.carpeta()
        primero, medio, ultimo = (self.volcado(carpeta, AHORA - timedelta(days=d)) for d in (202, 201, 200))  # 19, 20 y 21 de marzo
        respaldo.podar(carpeta, AHORA, dias=30)
        self.assertEqual(self.nombres(carpeta), [primero, ultimo])
        self.assertNotIn(medio, self.nombres(carpeta))

    def test_borra_los_restos_de_corridas_cortadas_pero_no_los_de_una_en_curso(self):
        carpeta = self.carpeta()
        self.volcado(carpeta, AHORA)
        viejo_sin_manifiesto = self.volcado(carpeta, AHORA - timedelta(days=3), manifiesto=False)
        en_curso = self.volcado(carpeta, AHORA - timedelta(hours=1), manifiesto=False)
        (carpeta / "x.dump.tmp").write_bytes(b"a medias")
        hace_dos_dias = (AHORA - timedelta(days=2)).timestamp()
        for ruta in (carpeta / f"{viejo_sin_manifiesto}.dump", carpeta / "x.dump.tmp"):
            os.utime(ruta, (hace_dos_dias, hace_dos_dias))
        (carpeta / "y.dump.tmp").write_bytes(b"corrida en curso")
        borrados = respaldo.podar(carpeta, AHORA, dias=30)
        self.assertEqual(sorted(borrados), sorted([f"{viejo_sin_manifiesto}.dump", "x.dump.tmp"]))
        self.assertTrue((carpeta / "y.dump.tmp").exists())
        self.assertTrue((carpeta / f"{en_curso}.dump").exists())

    def test_una_carpeta_vacia_o_que_no_existe_no_es_un_error(self):
        self.assertEqual(respaldo.podar(self.carpeta() / "no-esta", AHORA), [])


class ConfiguracionTests(unittest.TestCase):
    def test_lee_el_entorno(self):
        conf = respaldo.configuracion_desde_entorno({"DATOS_RESPALDO_DIR": "/mnt/respaldo", "DATOS_CRUDO_DIR": "/var/crudo", "DATOS_RESPALDO_DATABASE_URL": "postgresql://r@h/db",
                                                     "DATOS_DATABASE_URL": "postgresql://w@h/db", "DATOS_RESPALDO_DIAS": "45", "DATOS_PG_BIN": "/usr/lib/postgresql/17/bin"})
        self.assertEqual((conf.destino, conf.crudo, conf.url_volcado, conf.url_registro, conf.url_ensayo, conf.dias, conf.pg_bin),
                         (Path("/mnt/respaldo"), Path("/var/crudo"), "postgresql://r@h/db", "postgresql://w@h/db", None, 45, "/usr/lib/postgresql/17/bin"))

    def test_lo_invalido_se_rechaza(self):
        for env in ({}, {"DATOS_RESPALDO_DIR": "relativa/x"}, {"DATOS_RESPALDO_DIR": "/x", "DATOS_RESPALDO_DIAS": "0"},
                    {"DATOS_RESPALDO_DIR": "/x", "DATOS_RESPALDO_DIAS": "mucho"}):
            with self.assertRaises(ValueError, msg=str(env)):
                respaldo.configuracion_desde_entorno(env)


class EnsayoSeguroTests(Carpetas):
    """Lo que el ensayo se niega a hacer antes de tocar ninguna base."""

    def volcado_falso(self):
        carpeta = self.carpeta()
        (carpeta / "economia-20261007T061500Z.dump").write_bytes(b"volcado")
        (carpeta / "economia-20261007T061500Z.json").write_text(json.dumps({"esquema": "economia", "sha256": "0" * 64, "tablas": {}, "migraciones": []}))
        return carpeta / "economia-20261007T061500Z.dump"

    def test_solo_restaura_en_una_base_de_este_equipo(self):
        for url in ("postgresql://postgres@db.supabase.co/postgres", "postgresql://u@192.168.1.5/ensayo", "postgresql://u@localhost/ensayo?hostaddr=10.0.0.2"):
            with self.assertRaisesRegex(ErrorRespaldo, "ESTE equipo", msg=url):
                respaldo.ensayar(url, self.volcado_falso())

    def test_no_restaura_encima_de_la_base_del_servicio(self):
        with self.assertRaisesRegex(ErrorRespaldo, "misma que la del servicio"):
            respaldo.ensayar("postgresql://u@localhost:5432/chartbay", self.volcado_falso(), url_produccion="postgresql://otro@localhost/chartbay")

    def test_exige_nombrar_la_base(self):
        with self.assertRaisesRegex(ErrorRespaldo, "nombrar la base"):
            respaldo.ensayar("postgresql://u@localhost", self.volcado_falso())

    def test_un_volcado_danado_no_se_restaura(self):
        with self.assertRaisesRegex(ErrorRespaldo, "está dañado"):
            respaldo.ensayar("postgresql://u@localhost/ensayo", self.volcado_falso())


@unittest.skipUnless(HAY_PG_DUMP, "Faltan pg_dump y pg_restore (DATOS_PG_BIN o el PATH)")
class BaseRespaldo(BaseEsquema, Carpetas):
    def setUp(self):
        super().setUp()
        self.url = f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"
        self.crudo, self.destino = self.carpeta(), self.carpeta()
        sha256, self.relativa = AlmacenCrudo(self.crudo).guardar(b"contenido del xls")
        self.conn.execute("INSERT INTO descarga (fuente_id, url, sha256, bytes, ruta_crudo, estado) VALUES ('INDEC_IPC', 'https://x/a.xls', %s, 17, %s, 'nueva')",
                          (sha256, self.relativa))

    def aparte(self, sentencia):
        with psycopg.connect(URL, autocommit=True) as conn:
            conn.execute(sentencia)

    def base_de_ensayo(self):
        nombre = "ensayo_" + uuid.uuid4().hex[:10]
        self.aparte(f"CREATE DATABASE {nombre}")
        self.addCleanup(self.aparte, f"DROP DATABASE IF EXISTS {nombre} WITH (FORCE)")
        return make_conninfo(URL, dbname=nombre)

    def volcar(self, **kwargs):
        return respaldo.respaldar_base(self.url, self.destino / "base", AHORA, pg_bin=PG_BIN, **kwargs)

    def rol_de_respaldo(self):
        """Crea el rol con el SQL de la guía, que puede iniciar sesión sin clave (el Postgres de las pruebas confía en la conexión local)."""
        rol = "t_respaldo_" + uuid.uuid4().hex[:8]
        self.addCleanup(self.aparte, f"DROP OWNED BY {rol}; DROP ROLE IF EXISTS {rol}")  # también sus permisos por defecto
        for sentencia in respaldo.sql_del_rol(rol, self.schema, "postgres").split(";"):
            codigo = "\n".join(linea for linea in sentencia.splitlines() if not linea.startswith("--")).strip()
            if codigo:
                self.conn.execute(codigo)
        return make_conninfo(URL, user=rol)  # sin options: el search_path lo pone el rol, como en Supabase


class VolcadoTests(BaseRespaldo):
    def test_vuelca_el_esquema_con_un_manifiesto_que_dice_que_hay_adentro(self):
        volcado, manifiesto = self.volcar()
        self.assertEqual(volcado.name, f"{self.schema}-20261007T061500Z.dump")
        self.assertEqual(manifiesto["esquema"], self.schema)
        self.assertEqual((manifiesto["tablas"]["fuente"], manifiesto["tablas"]["serie"], manifiesto["tablas"]["descarga"], manifiesto["tablas"]["release"]), (1, 1, 1, 0))
        versiones = [v for (v,) in self.conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
        self.assertEqual(manifiesto["migraciones"], versiones)
        self.assertEqual((manifiesto["sha256"], manifiesto["bytes"]), (respaldo._hash(volcado), volcado.stat().st_size))
        self.assertEqual(json.loads(volcado.with_suffix(".json").read_text()), manifiesto)
        self.assertEqual(stat.S_IMODE(volcado.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((self.destino / "base").stat().st_mode), 0o700)
        self.assertEqual([p.name for p in (self.destino / "base").iterdir() if p.suffix == ".tmp"], [])

    def test_la_clave_va_por_el_entorno_y_no_en_la_linea_de_comandos(self):
        llamadas = []
        real = respaldo.subprocess.run

        def espia(comando, **kwargs):
            llamadas.append((comando, kwargs.get("env", {})))
            return real(comando, **kwargs)

        with patch.object(respaldo.subprocess, "run", espia):
            respaldo.respaldar_base(make_conninfo(self.url, password="clave-que-no-se-ve"), self.destino / "base", AHORA, pg_bin=PG_BIN)
        volcado = [(c, e) for c, e in llamadas if Path(c[0]).name == "pg_dump" and "--version" not in c]
        self.assertEqual(len(volcado), 1)
        comando, entorno = volcado[0]
        self.assertFalse(any("clave-que-no-se-ve" in parte for parte in comando))
        self.assertEqual(entorno["PGPASSWORD"], "clave-que-no-se-ve")
        self.assertIn(f"--schema={self.schema}", comando)
        self.assertTrue(any(parte.startswith("--snapshot=") for parte in comando))

    def test_un_pg_dump_viejo_se_rechaza_antes_de_volcar(self):
        with patch.object(respaldo, "version_mayor", return_value=9):
            with self.assertRaisesRegex(ErrorRespaldo, r"pg_dump 9 no puede respaldar PostgreSQL \d+: instalá postgresql-client-\d+"):
                self.volcar()
        self.assertEqual(list((self.destino / "base").iterdir()), [])

    def test_el_rol_de_la_guia_alcanza_para_volcar_y_anotar_y_no_escribe_nada_mas(self):
        url_del_rol = self.rol_de_respaldo()
        volcado, manifiesto = respaldo.respaldar_base(url_del_rol, self.destino / "base", AHORA, pg_bin=PG_BIN)
        self.assertEqual(manifiesto["esquema"], self.schema)
        self.assertEqual(respaldo.ensayar(self.base_de_ensayo(), volcado, pg_bin=PG_BIN)["tablas"], len(manifiesto["tablas"]))
        self.conn.execute("CREATE TABLE de_una_migracion_nueva (x int)")  # quien migra crea una tabla después
        with psycopg.connect(url_del_rol, autocommit=True) as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM de_una_migracion_nueva").fetchone()[0], 0)  # y el respaldo la puede leer
            conn.execute("INSERT INTO respaldo (iniciado_en, ok) VALUES (now(), true)")  # anota su corrida
            for sentencia in ("INSERT INTO fuente (id, nombre) VALUES ('X', 'x')", "UPDATE descarga SET bytes = 0",
                              "INSERT INTO candidato (corrida_id) VALUES (1)", "DELETE FROM respaldo"):
                with self.subTest(sentencia=sentencia), self.assertRaises((psycopg.errors.InsufficientPrivilege, psycopg.errors.RaiseException)):
                    conn.execute(sentencia)

    def test_un_rol_que_no_puede_leer_todo_el_esquema_se_informa(self):
        # Es lo que pasaría con datos_escritura, que no puede leer schema_migrations.
        rol = "t_rol_" + uuid.uuid4().hex[:8]
        self.conn.execute(f"CREATE ROLE {rol} LOGIN")
        self.addCleanup(self.aparte, f"DROP OWNED BY {rol}; DROP ROLE {rol}")
        self.conn.execute(f"GRANT USAGE ON SCHEMA {self.schema} TO {rol}")
        self.conn.execute(f"GRANT SELECT ON ALL TABLES IN SCHEMA {self.schema} TO {rol}")
        self.conn.execute(f"REVOKE ALL ON {self.schema}.schema_migrations FROM {rol}")
        with self.assertRaisesRegex(ErrorRespaldo, rf"no puede leer {self.schema}.schema_migrations"):
            respaldo.respaldar_base(make_conninfo(self.url, user=rol), self.destino / "base", AHORA, pg_bin=PG_BIN)

    def test_lo_volcado_es_la_misma_foto_que_lo_contado(self):
        # Si algo se escribe entre que se cuentan las filas y pg_dump arranca, el volcado no lo trae: el ensayo cuadra igual.
        real = respaldo._correr

        def escribe_antes_de_volcar(comando, *args, **kwargs):
            if Path(comando[0]).name == "pg_dump" and "--version" not in comando:
                self.conn.execute("INSERT INTO fuente (id, nombre) VALUES ('OTRA_FUENTE', 'Otra')")
            return real(comando, *args, **kwargs)

        with patch.object(respaldo, "_correr", escribe_antes_de_volcar):
            volcado, manifiesto = self.volcar()
        self.assertEqual(manifiesto["tablas"]["fuente"], 1)
        self.assertEqual(respaldo.ensayar(self.base_de_ensayo(), volcado, pg_bin=PG_BIN)["tablas"], len(manifiesto["tablas"]))


class EnsayoTests(BaseRespaldo):
    def test_restaura_y_comprueba_que_quedo_lo_mismo(self):
        volcado, manifiesto = self.volcar()
        url = self.base_de_ensayo()
        resultado = respaldo.ensayar(url, volcado, pg_bin=PG_BIN)
        self.assertEqual(resultado, {"volcado": volcado.name, "tablas": len(manifiesto["tablas"]), "filas": sum(manifiesto["tablas"].values())})
        with psycopg.connect(url, autocommit=True) as conn:
            self.assertEqual(conn.execute(f"SELECT nombre FROM {self.schema}.fuente").fetchone()[0], "INDEC")
            # Las restricciones de la base vuelven con el volcado: lo publicado sigue siendo de solo agregar.
            with self.assertRaisesRegex(psycopg.Error, "solo agregar"):
                conn.execute(f"DELETE FROM {self.schema}.descarga")

    def test_se_puede_repetir_sobre_el_ensayo_anterior(self):
        volcado, _ = self.volcar()
        url = self.base_de_ensayo()
        respaldo.ensayar(url, volcado, pg_bin=PG_BIN)
        self.assertEqual(respaldo.ensayar(url, volcado, pg_bin=PG_BIN)["volcado"], volcado.name)

    def test_no_toca_un_esquema_que_no_creo_un_ensayo(self):
        volcado, _ = self.volcar()
        url = self.base_de_ensayo()
        with psycopg.connect(url, autocommit=True) as conn:
            conn.execute(f"CREATE SCHEMA {self.schema}")
            conn.execute(f"CREATE TABLE {self.schema}.importante (x int)")
        with self.assertRaisesRegex(ErrorRespaldo, "no creó un ensayo: no se toca"):
            respaldo.ensayar(url, volcado, pg_bin=PG_BIN)
        with psycopg.connect(url) as conn:
            self.assertIsNotNone(conn.execute(f"SELECT to_regclass('{self.schema}.importante')").fetchone()[0])

    def test_si_lo_restaurado_no_coincide_con_el_manifiesto_falla(self):
        volcado, manifiesto = self.volcar()
        manifiesto["tablas"]["fuente"] = 5
        volcado.with_suffix(".json").write_text(json.dumps(manifiesto))
        with self.assertRaisesRegex(ErrorRespaldo, "fuente: 5 → 1"):
            respaldo.ensayar(self.base_de_ensayo(), volcado, pg_bin=PG_BIN)


class LineaDeComandosTests(BaseRespaldo):
    def setUp(self):
        super().setUp()
        self.ensayo = self.base_de_ensayo()

    def entorno(self, **cambios):
        entorno = {"DATOS_RESPALDO_DIR": str(self.destino), "DATOS_CRUDO_DIR": str(self.crudo), "DATOS_RESPALDO_DATABASE_URL": self.url,
                   "DATOS_DATABASE_URL": self.url, "DATOS_RESPALDO_ENSAYO_URL": self.ensayo, "DATOS_PG_BIN": PG_BIN or "", **cambios}
        return {k: v for k, v in entorno.items() if v is not None}

    def cli(self, *args, entorno=None):
        salida, errores = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, entorno if entorno is not None else self.entorno(), clear=True), \
                contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            codigo = respaldar.main(list(args))
        return codigo, salida.getvalue(), errores.getvalue()

    def registros(self):
        return self.conn.execute("SELECT ok, error, detalle FROM respaldo ORDER BY id").fetchall()

    def test_respalda_base_y_crudo_ensaya_y_lo_anota(self):
        codigo, salida, errores = self.cli()
        self.assertEqual(codigo, 0, errores)
        resumen = json.loads(salida)
        self.assertEqual(resumen["crudo"]["copiados"], 1)
        self.assertTrue(resumen["base"]["archivo"].startswith(self.schema))
        self.assertEqual(resumen["ensayo"]["tablas"], resumen["base"]["tablas"])
        self.assertEqual(resumen["errores"], [])
        self.assertTrue((self.destino / "crudo" / self.relativa).exists())
        ((ok, error, detalle),) = self.registros()
        self.assertEqual((ok, error, detalle["base"]["archivo"]), (True, None, resumen["base"]["archivo"]))

    def test_sin_rol_de_respaldo_igual_copia_el_crudo_pero_falla_y_lo_anota(self):
        codigo, salida, errores = self.cli(entorno=self.entorno(DATOS_RESPALDO_DATABASE_URL=None))
        self.assertEqual(codigo, 1)
        self.assertIn("falta DATOS_RESPALDO_DATABASE_URL", errores)
        self.assertEqual(json.loads(salida)["crudo"]["copiados"], 1)
        ((ok, error, _),) = self.registros()
        self.assertEqual(ok, False)
        self.assertIn("DATOS_RESPALDO_DATABASE_URL", error)

    def test_un_archivo_que_la_base_nombra_y_no_esta_es_una_falla(self):
        (self.crudo / self.relativa).unlink()
        codigo, _, errores = self.cli()
        self.assertEqual(codigo, 1)
        self.assertIn("faltan en el crudo y en la copia", errores)

    def test_sin_base_de_ensayo_respalda_igual_y_lo_advierte(self):
        codigo, _, errores = self.cli(entorno=self.entorno(DATOS_RESPALDO_ENSAYO_URL=None))
        self.assertEqual(codigo, 0)
        self.assertIn("no se ensaya restaurarlo", errores)

    def test_el_sql_del_rol_no_necesita_configuracion_ni_lleva_clave(self):
        codigo, salida, _ = self.cli("sql-del-rol", entorno={})
        self.assertEqual(codigo, 0)
        self.assertIn("GRANT SELECT ON ALL TABLES IN SCHEMA economia TO datos_respaldo;", salida)
        self.assertNotIn("PASSWORD", salida.upper().replace("\\PASSWORD", ""))

    def test_si_el_disco_de_respaldo_no_esta_montado_no_crea_la_carpeta_en_el_disco_del_sistema(self):
        ausente = self.destino / "disco-no-montado" / "chartbay-datos"
        codigo, _, errores = self.cli(entorno=self.entorno(DATOS_RESPALDO_DIR=str(ausente)))
        self.assertEqual(codigo, 1)
        self.assertIn("¿está montado el disco de respaldo?", errores)
        self.assertFalse(ausente.parent.exists())
        ((ok, error, _),) = self.registros()
        self.assertEqual(ok, False)
        self.assertIn("No existe DATOS_RESPALDO_DIR", error)

    def test_sin_destino_no_arranca(self):
        codigo, _, errores = self.cli(entorno={})
        self.assertEqual(codigo, 1)
        self.assertIn("Falta DATOS_RESPALDO_DIR", errores)

    def test_estado_ensayar_y_restaurar_crudo(self):
        self.cli()
        codigo, salida, _ = self.cli("estado")
        self.assertEqual(codigo, 0)
        self.assertIn("Último volcado:", salida)
        self.assertIn("Crudo: 1 archivos en la copia, 1 en el original.", salida)
        self.assertRegex(salida, r"\[\d+\] .* · ok")
        codigo, salida, _ = self.cli("ensayar")
        self.assertEqual((codigo, json.loads(salida)["filas"] > 0), (0, True))
        (self.crudo / self.relativa).unlink()
        codigo, salida, _ = self.cli("restaurar-crudo")
        self.assertEqual((codigo, json.loads(salida)["restaurados"]), (0, [self.relativa]))
        self.assertEqual((self.crudo / self.relativa).read_bytes(), b"contenido del xls")


class PaqueteTests(BaseRespaldo):
    def setUp(self):
        super().setUp()
        self.volcado, self.manifiesto = self.volcar()
        respaldo.respaldar_crudo(self.crudo, self.destino / "crudo")
        self.salida = self.carpeta()

    def contenido(self, archivo):
        import tarfile
        with tarfile.open(archivo) as tar:
            return {m.name: tar.extractfile(m).read() for m in tar.getmembers()}

    def test_junta_el_ultimo_volcado_su_manifiesto_y_el_crudo_con_un_indice(self):
        resultado = respaldo.empaquetar(self.destino, self.salida, AHORA)
        archivo = self.salida / resultado["archivo"]
        self.assertEqual((archivo.name, resultado["cifrado"], resultado["crudo"]), ("respaldo-datos-20261007T061500Z.tar.gz", False, 1))
        self.assertEqual(resultado["sha256"], respaldo._hash(archivo))
        self.assertEqual(list(self.salida.iterdir()), [archivo])  # sin temporales
        adentro = self.contenido(archivo)
        indice = json.loads(adentro["respaldo.json"])
        self.assertEqual(sorted(adentro), sorted(["respaldo.json", indice["volcado"]["archivo"], indice["volcado"]["manifiesto"], f"crudo/{self.relativa}"]))
        self.assertEqual(adentro[indice["volcado"]["archivo"]], self.volcado.read_bytes())
        self.assertEqual((indice["volcado"]["sha256"], indice["crudo"]), (self.manifiesto["sha256"], [self.relativa]))
        self.assertEqual(adentro[f"crudo/{self.relativa}"], b"contenido del xls")
        self.assertEqual(stat.S_IMODE(archivo.stat().st_mode), 0o600)

    def test_lo_empaquetado_se_restaura(self):
        import tarfile
        archivo = self.salida / respaldo.empaquetar(self.destino, self.salida, AHORA)["archivo"]
        abierto = self.carpeta()
        with tarfile.open(archivo) as tar:
            tar.extractall(abierto, filter="data")
        indice = json.loads((abierto / "respaldo.json").read_text())
        resultado = respaldo.ensayar(self.base_de_ensayo(), abierto / indice["volcado"]["archivo"], pg_bin=PG_BIN)
        self.assertEqual(resultado["tablas"], len(self.manifiesto["tablas"]))
        devuelto = self.carpeta()
        self.assertEqual(respaldo.restaurar_crudo(abierto / "crudo", devuelto)["restaurados"], [self.relativa])

    def test_con_una_clave_publica_sale_cifrado_con_age(self):
        # Un age falso que anota cómo lo llamaron y "cifra" anteponiendo una marca: lo que importa acá es cómo se lo usa.
        programas = self.carpeta()
        age = programas / "age"
        age.write_text("#!/usr/bin/env python3\nimport sys, pathlib\n"
                       "a = sys.argv[1:]\npathlib.Path(a[3]).write_bytes(b'CIFRADO:' + pathlib.Path(a[4]).read_bytes())\n"
                       f"pathlib.Path({str(programas / 'argumentos')!r}).write_text(' '.join(a[:3]))\n")
        age.chmod(0o755)
        clave = "age1" + "q" * 58
        resultado = respaldo.empaquetar(self.destino, self.salida, AHORA, destinatario_age=clave, age_bin=str(age))
        archivo = self.salida / resultado["archivo"]
        self.assertEqual((archivo.name, resultado["cifrado"]), ("respaldo-datos-20261007T061500Z.tar.gz.age", True))
        self.assertEqual(list(self.salida.iterdir()), [archivo])  # el paquete sin cifrar no queda
        self.assertEqual((programas / "argumentos").read_text(), f"--recipient {clave} --output")
        self.assertTrue(archivo.read_bytes().startswith(b"CIFRADO:\x1f\x8b"))  # adentro, un .tar.gz

    def test_una_clave_rara_o_sin_age_instalado_no_empaqueta_nada(self):
        with self.assertRaisesRegex(ErrorRespaldo, "tiene que empezar con age1"):
            respaldo.empaquetar(self.destino, self.salida, AHORA, destinatario_age="--output=/etc/passwd")
        with self.assertRaisesRegex(ErrorRespaldo, "No se encontró age"):
            respaldo.empaquetar(self.destino, self.salida, AHORA, destinatario_age="age1" + "q" * 58, age_bin="/no/existe/age")
        self.assertEqual(list(self.salida.iterdir()), [])

    def test_lo_danado_no_se_empaqueta(self):
        copia = self.destino / "crudo" / self.relativa
        self.danar(copia)
        with self.assertRaisesRegex(ErrorRespaldo, "copias del crudo dañadas"):
            respaldo.empaquetar(self.destino, self.salida, AHORA)
        self.danar(self.volcado, b"no es un volcado")
        with self.assertRaisesRegex(ErrorRespaldo, "está dañado"):
            respaldo.empaquetar(self.destino, self.salida, AHORA)
        with self.assertRaisesRegex(ErrorRespaldo, "No hay ningún volcado"):
            respaldo.empaquetar(self.carpeta(), self.salida, AHORA)
        self.assertEqual(list(self.salida.iterdir()), [])


class ComoEnGitHubTests(BaseRespaldo):
    """Lo mismo que corre el flujo de GitHub Actions: el crudo es una descarga del bucket y un solo rol, el de la guía, vuelca y anota."""

    def setUp(self):
        super().setUp()
        self.ensayo, self.url_del_rol = self.base_de_ensayo(), self.rol_de_respaldo()

    def entorno(self, **cambios):
        entorno = {"DATOS_RESPALDO_DIR": str(self.destino), "DATOS_CRUDO_DIR": str(self.crudo), "DATOS_CRUDO_DESCARGADO": "1",
                   "DATOS_RESPALDO_DATABASE_URL": self.url_del_rol, "DATOS_DATABASE_URL": self.url_del_rol,
                   "DATOS_RESPALDO_ENSAYO_URL": self.ensayo, "DATOS_PG_BIN": PG_BIN or "", **cambios}
        return {k: v for k, v in entorno.items() if v is not None}

    cli = LineaDeComandosTests.cli
    registros = LineaDeComandosTests.registros

    def test_respalda_anota_con_el_mismo_rol_y_empaqueta(self):
        codigo, salida, errores = self.cli()
        self.assertEqual(codigo, 0, errores)
        self.assertNotIn("mismo disco", errores)  # la descarga del bucket no es el original
        resumen = json.loads(salida)
        ((ok, error, detalle),) = self.registros()
        self.assertEqual((ok, error, detalle["base"]["archivo"]), (True, None, resumen["base"]["archivo"]))
        paquete = self.carpeta()
        codigo, salida, errores = self.cli("empaquetar", "--salida", str(paquete))
        self.assertEqual(codigo, 0, errores)
        self.assertIn("no va cifrado", errores)
        self.assertTrue((paquete / json.loads(salida)["archivo"]).is_file())

    def test_lo_que_falta_en_el_bucket_o_si_no_se_pudo_bajar(self):
        (self.crudo / self.relativa).unlink()
        codigo, _, errores = self.cli()
        self.assertEqual(codigo, 1)
        self.assertIn(f"Crudo: 1 faltan en el bucket: {self.relativa}", errores)
        codigo, _, errores = self.cli(entorno=self.entorno(DATOS_CRUDO_DIR=None))
        self.assertEqual(codigo, 1)
        self.assertIn("no se pudo bajar el bucket", errores)
        self.assertEqual([ok for ok, _, _ in self.registros()], [False, False])

    def test_empaquetar_sin_salida_no_arranca(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            respaldar.main(["empaquetar"])


class FlujoDeGitHubTests(unittest.TestCase):
    """El flujo `.github/workflows/respaldo-datos.yml` no se puede correr acá: se comprueba que use lo que el código espera."""

    RAIZ = Path(__file__).resolve().parents[2]

    def setUp(self):
        self.flujo = (self.RAIZ / ".github" / "workflows" / "respaldo-datos.yml").read_text(encoding="utf-8")

    def test_corre_el_respaldo_y_el_empaquetado_de_este_modulo(self):
        self.assertIn("python -m servicio_datos.respaldar\n", self.flujo)
        self.assertIn('python -m servicio_datos.respaldar empaquetar --salida "$RUNNER_TEMP/paquete"', self.flujo)
        self.assertIn("pip install -r servicio_datos/requirements.txt", self.flujo)

    def test_las_variables_son_las_que_lee_el_respaldo(self):
        import re
        usadas = set(re.findall(r"^\s+(DATOS_[A-Z_]+):", self.flujo, re.MULTILINE))
        documentadas = set(re.findall(r"^\s+(DATOS_[A-Z_]+)\s", respaldar.__doc__, re.MULTILINE))
        self.assertEqual(usadas - documentadas, set())
        self.assertGreaterEqual(usadas, {"DATOS_RESPALDO_DIR", "DATOS_CRUDO_DIR", "DATOS_CRUDO_DESCARGADO", "DATOS_RESPALDO_DATABASE_URL",
                                         "DATOS_DATABASE_URL", "DATOS_RESPALDO_ENSAYO_URL", "DATOS_PG_BIN", "DATOS_RESPALDO_AGE_DESTINATARIO"})

    def test_ensaya_en_un_postgres_descartable_de_la_misma_version_que_el_cliente(self):
        self.assertIn("DATOS_RESPALDO_ENSAYO_URL: postgresql://postgres:ensayo@localhost:5432/ensayo", self.flujo)
        self.assertIn("image: postgres:17", self.flujo)
        self.assertIn("postgresql-client-17", self.flujo)
        self.assertIn("DATOS_PG_BIN: /usr/lib/postgresql/17/bin", self.flujo)

    def test_baja_el_bucket_de_la_colecta_y_no_pide_mas_permisos_que_leer_el_codigo(self):
        almacen = (self.RAIZ / "supabase" / "functions" / "_compartido" / "almacen.ts").read_text(encoding="utf-8")
        self.assertIn('BUCKET_CRUDO = "economia-crudos"', almacen)
        self.assertIn('"s3://economia-crudos"', self.flujo)
        self.assertIn("permissions:\n  contents: read\n", self.flujo)
        self.assertNotIn("write", self.flujo.split("jobs:")[0])

    def test_los_secretos_y_variables_estan_explicados_en_la_guia(self):
        import re
        guia = (self.RAIZ / "docs" / "base-datos-supabase.md").read_text(encoding="utf-8")
        for nombre in set(re.findall(r"\$\{\{ (?:secrets|vars)\.([A-Z0-9_]+) \}\}", self.flujo)):
            with self.subTest(nombre=nombre):
                self.assertIn(nombre, guia)
                self.assertIn(nombre, self.flujo.split("name: Respaldo de datos")[0])  # y en el encabezado del flujo


if __name__ == "__main__":
    unittest.main()
