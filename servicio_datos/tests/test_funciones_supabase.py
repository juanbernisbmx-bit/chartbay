"""Las Edge Functions de `supabase/functions`, desde la suite de Python: sus pruebas de Deno, que el parser de TypeScript arme la
misma carga que el de Python con los archivos reales, y la colecta y los avisos de punta a punta contra una base de verdad, entrando
con el rol de las Edge Functions.

Necesitan Deno (se saltean sin él). Lo que usa los .xls de INDEC necesita DATOS_IPC_ORIGINALES_DIR.
"""
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
from psycopg.types.json import Jsonb

from servicio_datos import api_servicio, carga, repositorio
from servicio_datos.ipc import fuente
from servicio_datos.tests.base import URL, BaseEsquema
from servicio_datos.tests.test_api_servicio import carga_sintetica
from servicio_datos.tests.test_pipeline import HAY_PARSER, HOY, ORIGINALES

RAIZ = Path(__file__).resolve().parents[2]
FUNCIONES = RAIZ / "supabase" / "functions"
DENO = shutil.which("deno")
PERMISOS = ["--allow-net=127.0.0.1", "--allow-import=cdn.sheetjs.com,jsr.io", "--allow-read", "--allow-env"]
HAY_ORIGINALES = HAY_PARSER and all((ORIGINALES / n).is_file() for n in ("sh_ipc_08_26.xls", "sh_ipc_09_26.xls", "sh_ipc_aperturas.xls"))


def deno(*argumentos, entorno=None):
    return subprocess.run([DENO, *argumentos], cwd=FUNCIONES, capture_output=True, text=True, timeout=600,
                          env={**os.environ, "NO_COLOR": "1", **(entorno or {})})


@unittest.skipUnless(DENO, "Falta Deno")
class PruebasDeDenoTests(unittest.TestCase):
    def test_pasan_todas(self):
        # Las de integración las corren las clases de abajo, con su base.
        entorno = {k: v for k, v in os.environ.items() if not k.startswith(("DATOS_COLECTA_", "DATOS_AVISAR_"))}
        proceso = subprocess.run([DENO, "test", *PERMISOS, "."], cwd=FUNCIONES, capture_output=True, text=True, timeout=600, env={**entorno, "NO_COLOR": "1"})
        self.assertEqual(proceso.returncode, 0, proceso.stdout[-3000:] + proceso.stderr[-3000:])
        self.assertRegex(proceso.stdout, r"ok \| \d+ passed \| 0 failed")


@unittest.skipUnless(DENO and HAY_ORIGINALES, "Faltan Deno, xlrd o DATOS_IPC_ORIGINALES_DIR")
class ParserDeTypeScriptTests(unittest.TestCase):
    def test_arma_la_misma_carga_que_el_de_python_con_los_archivos_reales(self):
        from servicio_datos.ipc import parser
        for nacional in ("sh_ipc_09_26.xls", "sh_ipc_08_26.xls"):
            proceso = deno("run", "--allow-read", "--allow-import=cdn.sheetjs.com", "_compartido/imprimir_carga.ts", str(ORIGINALES), nacional, HOY.isoformat())
            self.assertEqual(proceso.returncode, 0, proceso.stderr[-2000:])
            series = {}
            for archivo in fuente.archivos(HOY):
                series.update(parser.leer_archivo(ORIGINALES / (nacional if archivo.clave == "nacional" else "sh_ipc_aperturas.xls"), archivo))
            esperado = json.loads(json.dumps(carga.carga_de(series, ["nacional", "aperturas"])))
            self.assertEqual(json.loads(proceso.stdout), esperado, nacional)


def como_usuario(url, usuario):
    """La misma URL de la base, con otro usuario y sin contraseña (el Postgres de las pruebas confía en la conexión local)."""
    partes = urlsplit(url)
    return urlunsplit(partes._replace(netloc=f"{usuario}@{partes.hostname}" + (f":{partes.port}" if partes.port else "")))


class BaseFunciones(BaseEsquema):
    """Un esquema migrado, con el de las Edge Functions y su rol, que puede iniciar sesión (como en Supabase)."""

    def setUp(self):
        super().setUp()
        self.api, self.rol = f"{self.schema}_servicio", f"servicio_{self.schema}"
        self.addCleanup(self.aparte, f"DROP SCHEMA IF EXISTS {self.api} CASCADE", f"DROP ROLE IF EXISTS {self.rol}")
        api_servicio.instalar(self.conn, api=self.api, rol=self.rol)
        self.conn.execute(f"ALTER ROLE {self.rol} LOGIN")

    def aparte(self, *sentencias):
        with psycopg.connect(URL, autocommit=True) as conn:
            for sentencia in sentencias:
                conn.execute(sentencia)


@unittest.skipUnless(DENO and HAY_ORIGINALES, "Faltan Deno, xlrd o DATOS_IPC_ORIGINALES_DIR")
class ColectaDePuntaAPuntaTests(BaseFunciones):
    def test_la_primera_deja_un_candidato_y_la_segunda_no_cambia_nada(self):
        proceso = deno("test", *PERMISOS, "colectar-ipc/integracion_test.ts",
                       entorno={"DATOS_COLECTA_URL": como_usuario(URL, self.rol), "DATOS_COLECTA_ESQUEMA": self.api,
                                "DATOS_IPC_ORIGINALES_DIR": str(ORIGINALES)})
        self.assertEqual(proceso.returncode, 0, proceso.stdout[-3000:] + proceso.stderr[-3000:])
        self.assertIn("1 passed", proceso.stdout)  # que no se haya salteado

        corridas = self.conn.execute("SELECT id, estado FROM corrida ORDER BY id").fetchall()
        self.assertEqual([e for _, e in corridas], ["con_candidato", "sin_cambios"])
        candidato = self.uno("SELECT id FROM candidato WHERE estado = 'abierto'")
        self.assertEqual(self.uno("SELECT count(*) FROM observacion_candidata WHERE candidato_id = %s", (candidato,)), 819)
        self.assertEqual(self.conn.execute("SELECT regexp_replace(url, '^.*/', ''), estado FROM descarga ORDER BY id").fetchall(),
                         [("sh_ipc_09_26.xls", "nueva"), ("sh_ipc_aperturas.xls", "nueva"), ("sh_ipc_09_26.xls", "identica"), ("sh_ipc_aperturas.xls", "identica")])
        self.assertIn("fecha_normalizada", {r for (r,) in self.conn.execute("SELECT DISTINCT regla FROM hallazgo")})
        resumen = self.uno("SELECT resumen FROM corrida WHERE id = %s", (corridas[0][0],))
        self.assertEqual((resumen["series"], resumen["observaciones"], resumen["candidato_id"]), (7, 819, candidato))
        self.assertEqual([a["publicada_en"] for a in resumen["archivos"]], ["2026-09-10T18:52:05+00:00"] * 2)
        self.assertEqual(self.conn.execute("SELECT nombre, hoja_origen FROM serie WHERE id = 'ipc_ng_cuyo'").fetchone(),
                         ("IPC nivel general - Cuyo", "Índices aperturas"))


@unittest.skipUnless(DENO, "Falta Deno")
class AvisosDePuntaAPuntaTests(BaseFunciones):
    def test_el_candidato_abierto_llega_a_slack_y_queda_anotado(self):
        corrida = repositorio.abrir_corrida_exclusiva(self.conn, fuente.FUENTE_ID, 1800)
        candidato = self.conn.execute("SELECT cargar_candidato(%s, %s, %s)", (corrida, HOY, Jsonb(carga_sintetica()))).fetchone()[0]["candidato_id"]
        proceso = deno("test", *PERMISOS, "avisar/integracion_test.ts",
                       entorno={"DATOS_AVISAR_URL": como_usuario(URL, self.rol), "DATOS_AVISAR_ESQUEMA": self.api})
        self.assertEqual(proceso.returncode, 0, proceso.stdout[-3000:] + proceso.stderr[-3000:])
        self.assertIn("1 passed", proceso.stdout)  # que no se haya salteado
        fila = self.conn.execute("SELECT clave, estado, intentos, entregas -> 'slack' ->> 'ok', tomado_hasta FROM aviso").fetchall()
        self.assertEqual(fila, [(f"candidato_nuevo:{candidato}", "enviado", 1, "true", None)])
