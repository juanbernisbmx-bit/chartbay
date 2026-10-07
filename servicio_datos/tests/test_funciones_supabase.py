"""Las Edge Functions de `supabase/functions`, desde la suite de Python: sus pruebas de Deno, que el parser de TypeScript arme la
misma carga que el de Python con los archivos reales, y la colecta de punta a punta contra una base de verdad.

Necesitan Deno (se saltean sin él). Lo que usa los .xls de INDEC necesita DATOS_IPC_ORIGINALES_DIR.
"""
import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

from servicio_datos import carga
from servicio_datos.ipc import fuente
from servicio_datos.tests.base import URL, BaseEsquema
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
        entorno = {k: v for k, v in os.environ.items() if not k.startswith("DATOS_COLECTA_")}  # la de integración la corre la clase de abajo
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


@unittest.skipUnless(DENO and HAY_ORIGINALES, "Faltan Deno, xlrd o DATOS_IPC_ORIGINALES_DIR")
class ColectaDePuntaAPuntaTests(BaseEsquema):
    def test_la_primera_deja_un_candidato_y_la_segunda_no_cambia_nada(self):
        proceso = deno("test", *PERMISOS, "colectar-ipc/integracion_test.ts",
                       entorno={"DATOS_COLECTA_URL": URL, "DATOS_COLECTA_ESQUEMA": self.schema, "DATOS_IPC_ORIGINALES_DIR": str(ORIGINALES)})
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
