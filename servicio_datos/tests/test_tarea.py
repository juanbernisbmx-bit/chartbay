"""Lanzador de tareas de cron: secretos, bloqueo, límite de tiempo y registro. No necesita Postgres."""
import contextlib
import importlib.util
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from servicio_datos import tarea
from servicio_datos.tarea import ErrorTarea, ejecutar_tarea, leer_entorno


class Base(unittest.TestCase):
    def setUp(self):
        self.carpeta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.carpeta, ignore_errors=True)

    def entorno(self, texto, modo=0o600):
        ruta = self.carpeta / "entorno"
        ruta.write_text(texto, encoding="utf-8")
        ruta.chmod(modo)
        return ruta

    def correr(self, codigo_python, **kwargs):
        salida = io.StringIO()
        with contextlib.redirect_stdout(salida), contextlib.redirect_stderr(io.StringIO()):
            codigo = ejecutar_tarea("prueba", (sys.executable, "-c", codigo_python), carpeta_bloqueos=self.carpeta, **kwargs)
        return codigo, salida.getvalue()


class EstadoDeLaUltimaCorridaTests(Base):
    """Lo que mira el latido para saber si cron sigue corriendo cada tarea."""

    def estado(self):
        return json.loads(tarea.ruta_estado(self.carpeta, "prueba").read_text())

    def test_guarda_cuando_termino_y_con_que_codigo(self):
        self.correr("pass")
        estado = self.estado()
        self.assertEqual((estado["tarea"], estado["codigo"], estado["fallas_seguidas"]), ("prueba", 0, 0))
        self.assertIn("+00:00", estado["fin"])

    def test_cuenta_las_fallas_seguidas_y_vuelve_a_cero_con_una_buena(self):
        for esperado in (1, 2, 3):
            self.correr("raise SystemExit(4)")
            self.assertEqual((self.estado()["codigo"], self.estado()["fallas_seguidas"]), (4, esperado))
        self.correr("pass")
        self.assertEqual(self.estado()["fallas_seguidas"], 0)

    def test_una_corrida_cortada_por_el_limite_cuenta_como_falla(self):
        self.correr("import time; time.sleep(30)", limite=0.5)
        self.assertEqual((self.estado()["codigo"], self.estado()["fallas_seguidas"]), (124, 1))

    def test_una_corrida_omitida_no_lo_toca(self):
        self.correr("pass")
        antes = self.estado()
        with open(self.carpeta / "chartbay-datos-prueba.lock", "a") as bloqueo:
            import fcntl
            fcntl.flock(bloqueo, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.correr("raise SystemExit(9)")
        self.assertEqual(self.estado(), antes)

    def test_un_estado_ilegible_se_reemplaza_sin_romper_la_tarea(self):
        tarea.ruta_estado(self.carpeta, "prueba").write_text("{no es json")
        self.assertEqual(self.correr("raise SystemExit(2)")[0], 2)
        self.assertEqual(self.estado()["fallas_seguidas"], 1)

    def test_una_consulta_a_mano_con_subcomando_no_cuenta_como_corrida_programada(self):
        falsa = {"respaldar": (sys.executable, "-c", "pass")}
        with patch.dict(tarea.TAREAS, falsa), patch.dict(os.environ, {"DATOS_RUN_DIR": str(self.carpeta)}), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            tarea.main(["respaldar", "estado"])
            self.assertFalse(tarea.ruta_estado(self.carpeta, "respaldar").exists())
            tarea.main(["respaldar"])
            self.assertTrue(tarea.ruta_estado(self.carpeta, "respaldar").exists())
            tarea.ruta_estado(self.carpeta, "respaldar").unlink()
            tarea.main(["respaldar", "--limite", "30"])  # opciones (como en el cron del analista) sí son la forma programada
            self.assertTrue(tarea.ruta_estado(self.carpeta, "respaldar").exists())


class EntornoTests(Base):
    def test_lee_pares_clave_valor_ignorando_comentarios_y_lineas_vacias(self):
        ruta = self.entorno("# secretos\n\nDATOS_DATABASE_URL=postgresql://u:p@h/db?sslmode=require\nOTRA = valor con espacios \n"
                            "CON_COMILLAS=\"entre dobles\"\nSIMPLES='entre simples'\nIGUAL=a=b=c\nVACIA=\n")
        self.assertEqual(leer_entorno(ruta), {
            "DATOS_DATABASE_URL": "postgresql://u:p@h/db?sslmode=require", "OTRA": "valor con espacios", "CON_COMILLAS": "entre dobles",
            "SIMPLES": "entre simples", "IGUAL": "a=b=c", "VACIA": ""})

    def test_no_ejecuta_ni_expande_nada(self):
        marca = self.carpeta / "ejecutado"
        ruta = self.entorno(f"CLAVE=$(touch {marca})\nOTRA=`touch {marca}`\nTERCERA=${{HOME}}\n")
        valores = leer_entorno(ruta)
        self.assertFalse(marca.exists())
        self.assertEqual(valores["TERCERA"], "${HOME}")

    def test_un_archivo_legible_por_otros_se_rechaza(self):
        for modo in (0o644, 0o640, 0o604, 0o660):
            with self.assertRaisesRegex(ErrorTarea, "chmod 600", msg=oct(modo)):
                leer_entorno(self.entorno("A=1\n", modo))
        self.assertEqual(leer_entorno(self.entorno("A=1\n", 0o600)), {"A": "1"})
        self.assertEqual(leer_entorno(self.entorno("A=1\n", 0o400)), {"A": "1"})

    def test_un_archivo_de_otro_usuario_se_rechaza(self):
        ruta = self.entorno("A=1\n")
        with patch("os.geteuid", return_value=os.geteuid() + 1), self.assertRaisesRegex(ErrorTarea, "del usuario que corre la tarea"):
            leer_entorno(ruta)

    def test_un_archivo_que_no_existe_se_informa(self):
        with self.assertRaisesRegex(ErrorTarea, "No se pudo leer"):
            leer_entorno(self.carpeta / "no-existe")

    def test_una_linea_mal_formada_se_informa_sin_repetir_su_contenido(self):
        for malo in ("clave_en_minuscula=1", "export CLAVE=1", "SIN_IGUAL", "1EMPIEZA=1"):
            with self.assertRaises(ErrorTarea, msg=malo) as contexto:
                leer_entorno(self.entorno(f"BIEN=1\n{malo}\n"))
            self.assertIn("línea 2", str(contexto.exception))
            self.assertNotIn(malo, str(contexto.exception))


class EjecucionTests(Base):
    def test_pasa_el_entorno_a_la_tarea_y_devuelve_su_codigo(self):
        salida_hijo = self.carpeta / "hijo"
        codigo, _ = self.correr(f"import os, pathlib; pathlib.Path({str(salida_hijo)!r}).write_text(os.environ['SECRETO_DE_PRUEBA']); raise SystemExit(7)",
                                entorno={"SECRETO_DE_PRUEBA": "valor-del-archivo"})
        self.assertEqual(codigo, 7)
        self.assertEqual(salida_hijo.read_text(), "valor-del-archivo")

    def test_deja_una_linea_de_registro_con_el_codigo_y_lo_que_tardo(self):
        codigo, salida = self.correr("pass")
        registro = json.loads(salida.strip().splitlines()[-1])
        self.assertEqual((codigo, registro["tarea"], registro["codigo"]), (0, "prueba", 0))
        self.assertGreaterEqual(registro["segundos"], 0)
        self.assertLessEqual(registro["inicio"], registro["fin"])

    def test_una_corrida_que_sigue_en_curso_hace_que_la_siguiente_se_omita_sin_error(self):
        marca = self.carpeta / "segunda-corrio"
        primera = threading.Thread(target=lambda: self.correr("import time; time.sleep(2)"))
        primera.start()
        time.sleep(0.6)  # que la primera ya tenga el bloqueo
        codigo, salida = self.correr(f"import pathlib; pathlib.Path({str(marca)!r}).write_text('x')")
        primera.join()
        self.assertEqual(codigo, 0)
        self.assertIn("ya hay una corrida en curso", salida)
        self.assertFalse(marca.exists())

    def test_el_bloqueo_se_libera_al_terminar_y_cada_tarea_tiene_el_suyo(self):
        self.assertEqual(self.correr("pass")[0], 0)
        self.assertNotIn("omitida", self.correr("pass")[1])
        # Otra tarea no se bloquea con esta.
        primera = threading.Thread(target=lambda: self.correr("import time; time.sleep(1.5)"))
        primera.start()
        time.sleep(0.5)
        salida = io.StringIO()
        with contextlib.redirect_stdout(salida):
            ejecutar_tarea("otra", (sys.executable, "-c", "pass"), carpeta_bloqueos=self.carpeta)
        primera.join()
        self.assertNotIn("omitida", salida.getvalue())

    def test_una_corrida_colgada_se_corta_con_todo_lo_que_lanzo(self):
        pid_hijo, pid_nieto = self.carpeta / "hijo", self.carpeta / "nieto"
        codigo, _ = self.correr(
            "import os, subprocess, sys, time, pathlib\n"
            f"pathlib.Path({str(pid_hijo)!r}).write_text(str(os.getpid()))\n"
            "n = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
            f"pathlib.Path({str(pid_nieto)!r}).write_text(str(n.pid))\n"
            "time.sleep(60)", limite=1.5)
        self.assertEqual(codigo, 124)
        time.sleep(0.3)
        for archivo in (pid_hijo, pid_nieto):
            with self.assertRaises(ProcessLookupError, msg=f"{archivo.name} sigue vivo"):
                os.kill(int(archivo.read_text()), 0)

    def test_una_corrida_cortada_libera_el_bloqueo(self):
        self.correr("import time; time.sleep(60)", limite=0.5)
        self.assertNotIn("omitida", self.correr("pass")[1])


class LineaDeComandosTests(Base):
    def cli(self, *args):
        salida, errores = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            codigo = tarea.main(list(args))
        return codigo, salida.getvalue(), errores.getvalue()

    def test_las_tareas_apuntan_a_modulos_que_existen(self):
        self.assertEqual(sorted(tarea.TAREAS), ["agente", "avisar", "ejecutar", "latido", "respaldar"])
        for comando in tarea.TAREAS.values():
            modulo = comando[comando.index("-m") + 1]
            self.assertIsNotNone(importlib.util.find_spec(modulo), modulo)

    def test_con_permisos_abiertos_no_arranca_y_sale_con_2(self):
        ruta = self.entorno("DATOS_DATABASE_URL=postgresql://u:clave-secreta@h/db\n", 0o644)
        codigo, _, errores = self.cli("--entorno", str(ruta), "avisar")
        self.assertEqual(codigo, 2)
        self.assertIn("chmod 600", errores)
        self.assertNotIn("clave-secreta", errores)

    def test_con_el_entorno_bien_corre_la_tarea_con_esas_variables(self):
        ruta = self.entorno("DATOS_PRUEBA_TAREA=llego\n")
        resultado = self.carpeta / "resultado"
        falsa = {"ejecutar": (sys.executable, "-c", f"import os, pathlib; pathlib.Path({str(resultado)!r}).write_text(os.environ['DATOS_PRUEBA_TAREA'])")}
        with patch.dict(tarea.TAREAS, falsa), patch.dict(os.environ, {"DATOS_RUN_DIR": str(self.carpeta)}):
            codigo, salida, _ = self.cli("--entorno", str(ruta), "ejecutar")
        self.assertEqual(codigo, 0)
        self.assertEqual(resultado.read_text(), "llego")
        self.assertEqual(json.loads(salida.strip().splitlines()[-1])["tarea"], "ejecutar")

    def test_lo_que_se_escribe_despues_del_nombre_se_le_pasa_a_la_tarea(self):
        resultado = self.carpeta / "argumentos"
        falsa = {"avisar": (sys.executable, "-c", f"import sys, pathlib; pathlib.Path({str(resultado)!r}).write_text(' '.join(sys.argv[1:]))")}
        with patch.dict(tarea.TAREAS, falsa), patch.dict(os.environ, {"DATOS_RUN_DIR": str(self.carpeta)}):
            self.assertEqual(self.cli("avisar", "probar", "--hoy", "2026-10-06")[0], 0)
        self.assertEqual(resultado.read_text(), "probar --hoy 2026-10-06")

    def test_el_limite_del_lanzador_y_el_de_la_tarea_no_se_confunden(self):
        # Así está la línea de cron del analista: `tarea --limite 3600 agente --limite 3000`.
        resultado = self.carpeta / "argumentos"
        falsa = {"agente": (sys.executable, "-c", f"import sys, pathlib; pathlib.Path({str(resultado)!r}).write_text(' '.join(sys.argv[1:]))")}
        with patch.dict(tarea.TAREAS, falsa), patch.dict(os.environ, {"DATOS_RUN_DIR": str(self.carpeta)}), \
                patch.object(tarea, "ejecutar_tarea", wraps=tarea.ejecutar_tarea) as espia:
            self.assertEqual(self.cli("--limite", "3600", "agente", "--limite", "3000")[0], 0)
        self.assertEqual(resultado.read_text(), "--limite 3000")
        self.assertEqual(espia.call_args.args[3], 3600.0)

    def test_una_tarea_desconocida_la_rechaza_argparse(self):
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            tarea.main(["borrar-todo"])


if __name__ == "__main__":
    unittest.main()
