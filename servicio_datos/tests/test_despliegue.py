"""Archivos de despliegue: que sean coherentes entre sí y no pierdan lo que los hace seguros. No necesita Postgres.

No reemplaza probarlos en el equipo de verdad (ni systemd ni cron se pueden correr acá), pero atrapa lo que se rompe
al cambiar una ruta, un puerto o una variable en un archivo y olvidarse de los otros.
"""
import importlib
import re
import shutil
import tempfile
import unittest
from pathlib import Path

from servicio_datos import monitor, respaldo, tarea
from servicio_datos.agente.modelo import modelo_desde_entorno
from servicio_datos.canales import configuracion_desde_entorno
from servicio_datos.revision.__main__ import revisores_desde_entorno

RAIZ = Path(__file__).resolve().parents[2]
DESPLIEGUE = RAIZ / "servicio_datos" / "despliegue"
USUARIO, ENTORNO, REPO = "chartbay-datos", "/etc/chartbay-datos/entorno", "/opt/chartbay-datos/repo"


def leer(nombre):
    return (DESPLIEGUE / nombre).read_text(encoding="utf-8")


def campo_cron_valido(campo, minimo, maximo):
    for parte in campo.split(","):
        base, _, paso = parte.partition("/")
        if paso and not (paso.isdigit() and int(paso) > 0):
            return False
        if base == "*":
            continue
        rango = base.split("-")
        if len(rango) > 2 or not all(r.isdigit() and minimo <= int(r) <= maximo for r in rango):
            return False
    return True


def trabajos_cron():
    trabajos, entorno = [], {}
    for linea in leer("chartbay-datos.cron").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#"):
            continue
        asignacion = re.match(r"^([A-Z_]+)=(.*)$", linea)
        if asignacion:
            entorno[asignacion.group(1)] = asignacion.group(2).strip('"')
            continue
        campos = linea.split(None, 6)
        trabajos.append({"horario": campos[:5], "usuario": campos[5], "comando": campos[6]})
    return trabajos, entorno


def expandir_campo(campo, maximo):
    """Los valores de un campo de cron: `*`, `*/n`, `a,b` o un número."""
    if campo == "*":
        return list(range(maximo + 1))
    if campo.startswith("*/"):
        return list(range(0, maximo + 1, int(campo[2:])))
    return [int(v) for v in campo.split(",")]


def nombre_de_tarea(comando):
    """La tarea que lanza un trabajo de cron: lo primero que no es una opción del lanzador."""
    return re.search(r"servicio_datos\.tarea (?:--\S+ \S+ )*(\w+)", comando).group(1)


def seccion_unidad():
    valores = {}
    for linea in leer("chartbay-revision.service").splitlines():
        if linea.strip() and not linea.startswith(("#", "[")):
            clave, _, valor = linea.partition("=")
            valores[clave.strip()] = valor.strip()
    return valores


class CronTests(unittest.TestCase):
    def test_el_horario_es_valido(self):
        trabajos, _ = trabajos_cron()
        self.assertEqual(len(trabajos), 5)
        for t in trabajos:
            for campo, (minimo, maximo) in zip(t["horario"], ((0, 59), (0, 23), (1, 31), (1, 12), (0, 7))):
                self.assertTrue(campo_cron_valido(campo, minimo, maximo), f"{campo} en {t['comando'][:60]}")

    def test_hay_exactamente_una_linea_por_tarea_y_corren_como_el_usuario_del_servicio(self):
        trabajos, _ = trabajos_cron()
        self.assertEqual(sorted(nombre_de_tarea(t["comando"]) for t in trabajos), sorted(tarea.TAREAS))
        for t in trabajos:
            self.assertEqual(t["usuario"], USUARIO)
            self.assertNotEqual(t["usuario"], "root")
            self.assertIn(f"--entorno {ENTORNO}", t["comando"])
            self.assertIn(f"cd {REPO} &&", t["comando"])
            self.assertIn("/opt/chartbay-datos/venv/bin/python -m servicio_datos.tarea", t["comando"])

    def test_cada_tarea_deja_su_propio_registro(self):
        for t in trabajos_cron()[0]:
            nombre = nombre_de_tarea(t["comando"])
            self.assertTrue(t["comando"].endswith(f">> /var/log/chartbay-datos/{nombre}.log 2>&1"), nombre)

    def test_avisar_corre_aparte_y_seguido(self):
        # Los avisos de silencio los detecta quien mira desde afuera: si solo corriera junto con ejecutar, no servirían.
        por_tarea = {nombre_de_tarea(t["comando"]): t for t in trabajos_cron()[0]}
        self.assertNotEqual(por_tarea["ejecutar"]["horario"], por_tarea["avisar"]["horario"])
        minuto, hora = por_tarea["avisar"]["horario"][:2]
        self.assertRegex(hora, r"^\*/([1-6])$", "avisar tiene que correr al menos cada 6 horas")

    def test_el_analista_corre_cada_hora_con_un_presupuesto_menor_que_el_limite_del_lanzador(self):
        # Si el lanzador lo cortara antes de que termine con gracia, perdería el resumen de la corrida; y si dura más que la
        # hora, la corrida siguiente se omite (flock) en vez de pisarlo.
        comando = {nombre_de_tarea(t["comando"]): t for t in trabajos_cron()[0]}["agente"]
        self.assertEqual(comando["horario"][1:], ["*", "*", "*", "*"])
        limite_lanzador = int(re.search(r"servicio_datos\.tarea .*?--limite (\d+) agente", comando["comando"]).group(1))
        limite_trabajo = int(re.search(r" agente --limite (\d+) >>", comando["comando"]).group(1))
        self.assertLess(limite_trabajo, limite_lanzador)
        self.assertLessEqual(limite_lanzador, 3600)

    def test_el_respaldo_corre_cada_dia_de_madrugada_lejos_de_la_colecta(self):
        por_tarea = {nombre_de_tarea(t["comando"]): t for t in trabajos_cron()[0]}
        minuto, hora, dia, mes, semana = por_tarea["respaldar"]["horario"]
        self.assertTrue(minuto.isdigit() and hora.isdigit() and int(hora) < 7, "una vez por día, de madrugada")
        self.assertEqual((dia, mes, semana), ("*", "*", "*"))
        self.assertNotIn(hora, por_tarea["ejecutar"]["horario"][1].split(","))
        self.assertRegex(por_tarea["respaldar"]["comando"], r"--limite (\d+) respaldar >>")

    def test_el_latido_corre_seguido_y_termina_antes_del_siguiente(self):
        comando = {nombre_de_tarea(t["comando"]): t for t in trabajos_cron()[0]}["latido"]
        self.assertEqual(comando["horario"], ["*/10", "*", "*", "*", "*"])
        self.assertLess(int(re.search(r"--limite (\d+) latido", comando["comando"]).group(1)), 10 * 60)

    def test_lo_que_el_latido_espera_de_cada_tarea_cuadra_con_el_cron(self):
        # Si alguien cambia un horario y no el ritmo que espera el latido, este avisaría de una falla que no es (o callaría una que sí).
        por_tarea = {nombre_de_tarea(t["comando"]): t for t in trabajos_cron()[0]}
        self.assertEqual(set(monitor.CADENCIAS), set(por_tarea) - {"latido"})
        for nombre, cadencia in monitor.CADENCIAS.items():
            minutos, horas = (expandir_campo(c, maximo) for c, maximo in zip(por_tarea[nombre]["horario"][:2], (59, 23)))
            corridas = sorted(h * 60 + m for h in horas for m in minutos)
            mayor = max(b - a for a, b in zip(corridas, corridas[1:] + [corridas[0] + 24 * 60]))
            self.assertLess(mayor * 60, cadencia.total_seconds(), f"{nombre}: el cron deja {mayor / 60:.1f} h entre corridas")
            self.assertLessEqual(cadencia.total_seconds(), mayor * 60 + 3 * 3600, f"{nombre}: el latido tarda demasiado en notar que no corre")

    def test_el_entorno_del_cron(self):
        _, entorno = trabajos_cron()
        self.assertEqual(entorno["MAILTO"], "")  # sin un servidor de correo configurado cron no puede mandar nada
        self.assertEqual(entorno["CRON_TZ"], "America/Argentina/Buenos_Aires")
        self.assertEqual(entorno["DATOS_RUN_DIR"], "/var/lib/chartbay-datos")


class EntornoEjemploTests(unittest.TestCase):
    def cargar(self):
        carpeta = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, carpeta, ignore_errors=True)
        destino = carpeta / "entorno"
        shutil.copy(DESPLIEGUE / "entorno.ejemplo", destino)
        destino.chmod(0o600)
        return tarea.leer_entorno(destino)  # el mismo lector que usa cron

    def test_lo_lee_el_lanzador_de_tareas(self):
        self.assertIn("DATOS_DATABASE_URL", self.cargar())

    def test_cubre_todas_las_variables_que_lee_el_servicio(self):
        usadas = set()
        for ruta in (RAIZ / "servicio_datos").rglob("*.py"):
            if "tests" in ruta.parts:
                continue
            usadas |= set(re.findall(r'"((?:DATOS|CHARTBAY)_[A-Z_]+)"', ruta.read_text(encoding="utf-8")))
        usadas -= {"DATOS_TEST_DATABASE_URL", "DATOS_IPC_ORIGINALES_DIR"}  # solo de las pruebas
        faltan = usadas - set(self.cargar())
        self.assertEqual(faltan, set(), f"el servicio lee estas variables y el ejemplo no las documenta: {sorted(faltan)}")

    def test_no_trae_lo_que_no_debe_estar_en_el_servidor(self):
        claves = set(self.cargar())
        self.assertNotIn("SUPABASE_ADMIN_DATABASE_URL", claves)  # el administrador de la base no vive en el servidor diario
        self.assertNotIn("CHARTBAY_DATABASE_URL", claves)  # esa es de la web pública, no de este servicio

    def test_los_valores_son_marcadores_y_no_secretos_de_verdad(self):
        valores = self.cargar()
        self.assertIn("PROJECT_REF", valores["DATOS_DATABASE_URL"])
        self.assertIn("CLAVE", valores["DATOS_DATABASE_URL"])
        for vacia in ("DATOS_AVISOS_SLACK_URL", "DATOS_AVISOS_SMTP_CLAVE", "DATOS_AVISOS_SMTP_USUARIO"):
            self.assertEqual(valores[vacia], "")
        self.assertEqual(valores["DATOS_REVISORES"], "USUARIO=HASH")

    def test_el_analista_viene_apagado_y_solo_acepta_un_modelo_local(self):
        valores = self.cargar()
        self.assertEqual(valores["DATOS_AGENTE_MODELO"], "")  # el modelo lo elige quien instala, con `agente probar`
        self.assertIsNone(modelo_desde_entorno(valores))
        elegido = modelo_desde_entorno({**valores, "DATOS_AGENTE_MODELO": "qwen2.5:7b"})  # con modelo elegido, el resto del ejemplo sirve tal cual
        self.assertEqual((elegido.nombre, elegido._timeout), ("qwen2.5:7b", 180))
        self.assertRegex(valores["DATOS_AGENTE_URL"], r"^http://(127\.0\.0\.1|localhost)[:/]")

    def test_el_respaldo_lo_acepta_tal_cual_y_usa_un_rol_de_solo_lectura(self):
        valores = self.cargar()
        conf = respaldo.configuracion_desde_entorno(valores)
        self.assertEqual((conf.dias, conf.url_ensayo, conf.pg_bin), (30, None, None))
        self.assertIn("datos_respaldo.PROJECT_REF:CLAVE@", conf.url_volcado)  # no el rol que escribe
        self.assertNotIn("datos_escritura", conf.url_volcado)
        self.assertTrue(str(conf.destino).startswith("/mnt/"), "el ejemplo sugiere otro disco, no una carpeta junto al crudo")

    def test_el_latido_mira_donde_escucha_la_interfaz(self):
        valores = self.cargar()
        puerto = re.search(r"--bind 127\.0\.0\.1:(\d+)", seccion_unidad()["ExecStart"]).group(1)
        self.assertEqual(valores["DATOS_MONITOR_SALUD_LOCAL"], f"http://127.0.0.1:{puerto}/salud")
        self.assertEqual(monitor.SALUD_LOCAL, valores["DATOS_MONITOR_SALUD_LOCAL"])
        self.assertEqual(valores["DATOS_MONITOR_URL"], "")  # es una credencial: el ejemplo no trae una

    def test_el_servicio_lo_acepta_tal_cual(self):
        valores = self.cargar()
        configuracion = configuracion_desde_entorno(valores)
        self.assertEqual((configuracion.canales, configuracion.recordatorio_dias), ((), 3))  # sin canales: no avisa, pero tampoco falla
        self.assertEqual(configuracion.url_base, "https://revision.ejemplo.org")
        self.assertEqual(revisores_desde_entorno(valores["DATOS_REVISORES"]), {"USUARIO": "HASH"})
        self.assertEqual(valores["DATOS_REVISION_PROXY"], "1")


class UnidadDeSystemdTests(unittest.TestCase):
    def test_escucha_solo_en_el_equipo_y_no_corre_como_root(self):
        unidad = seccion_unidad()
        self.assertIn("--bind 127.0.0.1:", unidad["ExecStart"])
        self.assertNotIn("0.0.0.0", unidad["ExecStart"])
        self.assertEqual((unidad["User"], unidad["Group"]), (USUARIO, USUARIO))

    def test_usa_un_solo_worker_porque_el_limite_de_intentos_vive_en_memoria(self):
        self.assertIn("--workers 1", seccion_unidad()["ExecStart"])

    def test_la_fabrica_que_arranca_existe(self):
        fabrica = re.search(r'"([\w.]+):(\w+)\(\)"', seccion_unidad()["ExecStart"])
        self.assertIsNotNone(fabrica)
        self.assertTrue(callable(getattr(importlib.import_module(fabrica.group(1)), fabrica.group(2))))

    def test_toma_los_secretos_del_mismo_archivo_que_cron(self):
        self.assertEqual(seccion_unidad()["EnvironmentFile"], ENTORNO)

    def test_esta_endurecida(self):
        unidad = seccion_unidad()
        for clave, valor in (("NoNewPrivileges", "true"), ("ProtectSystem", "strict"), ("PrivateTmp", "true"), ("ProtectHome", "true"),
                             ("CapabilityBoundingSet", ""), ("RestrictSUIDSGID", "true"), ("Restart", "on-failure")):
            self.assertEqual(unidad.get(clave), valor, clave)

    def test_el_registro_de_accesos_no_incluye_el_usuario(self):
        formato = re.search(r"--access-logformat '([^']*)'", seccion_unidad()["ExecStart"]).group(1)
        self.assertNotIn("%(u)s", formato)  # si alguien escribe su clave en el campo de usuario, no queda en el log


class ProxyYRegistrosTests(unittest.TestCase):
    def test_caddy_apunta_a_donde_escucha_el_servicio_y_a_ningun_otro_lado(self):
        puerto = re.search(r"--bind 127\.0\.0\.1:(\d+)", seccion_unidad()["ExecStart"]).group(1)
        caddy = leer("Caddyfile")
        self.assertIn(f"reverse_proxy 127.0.0.1:{puerto}", caddy)
        self.assertNotIn("0.0.0.0", caddy)
        self.assertIn("header_down -Server", caddy)

    def test_el_dominio_de_ejemplo_es_el_mismo_en_el_proxy_y_en_el_entorno(self):
        dominio = re.search(r"^(\S+) \{", leer("Caddyfile"), re.M).group(1)
        self.assertIn(f"https://{dominio}", leer("entorno.ejemplo"))

    def test_logrotate_cubre_los_registros_que_escribe_cron(self):
        rotacion = leer("logrotate-chartbay-datos")
        self.assertIn("/var/log/chartbay-datos/*.log", rotacion)
        self.assertIn(f"create 0640 {USUARIO} {USUARIO}", rotacion)

    def test_gunicorn_esta_entre_las_dependencias(self):
        self.assertRegex((RAIZ / "servicio_datos" / "requirements.txt").read_text(), r"(?m)^gunicorn")

    def test_la_guia_nombra_cada_archivo_de_despliegue(self):
        guia = (RAIZ / "docs" / "despliegue-servicio-datos.md").read_text(encoding="utf-8")
        for archivo in DESPLIEGUE.iterdir():
            self.assertIn(archivo.name, guia, f"la guía no menciona {archivo.name}")

    def test_la_guia_explica_el_analista_local(self):
        guia = (RAIZ / "docs" / "despliegue-servicio-datos.md").read_text(encoding="utf-8")
        for texto in ("DATOS_AGENTE_MODELO", "agente probar", "agente estado", "agente.log", "Solo propone", "nunca con un\nmodelo real"):
            self.assertIn(texto, guia)

    def test_la_guia_explica_el_latido(self):
        guia = (RAIZ / "docs" / "despliegue-servicio-datos.md").read_text(encoding="utf-8")
        for texto in ("DATOS_MONITOR_URL", "latido probar", "latido estado", "latido.log", "/fail", "Healthchecks"):
            self.assertIn(texto, guia)

    def test_la_guia_explica_el_respaldo_y_como_restaurar(self):
        guia = (RAIZ / "docs" / "despliegue-servicio-datos.md").read_text(encoding="utf-8")
        for texto in ("DATOS_RESPALDO_DIR", "respaldar sql-del-rol", "respaldar ensayar", "restaurar-crudo", "pg_restore", "otro disco", "respaldar.log"):
            self.assertIn(texto, guia)
        self.assertNotIn("Respaldos**: no están automatizados", guia)

    def test_todos_los_archivos_usan_las_mismas_rutas_base(self):
        for nombre in ("chartbay-datos.cron", "chartbay-revision.service"):
            texto = leer(nombre)
            self.assertIn(REPO, texto)
            self.assertIn("/opt/chartbay-datos/venv/bin/", texto)
            self.assertIn(ENTORNO, texto)


if __name__ == "__main__":
    unittest.main()
