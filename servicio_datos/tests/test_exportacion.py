"""La copia pública de lo aprobado (exportacion.py), con releases publicados de verdad: pipeline, revisión y publicación."""
import contextlib
import io
import json
import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import patch

from servicio_datos import exportacion, exportar
from servicio_datos.publicacion import hash_contenido
from servicio_datos.tests.base import URL
from servicio_datos.tests.test_colector import NAC, xls
from servicio_datos.tests.test_publicacion import B, BasePublicacion

LICENCIA = ("CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/", "Fuente: INDEC, Índice de precios al consumidor.")


class BaseExportacion(BasePublicacion):
    def setUp(self):
        super().setUp()
        self.destino = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.destino, ignore_errors=True)
        self.conn.execute("UPDATE fuente SET licencia = %s, licencia_url = %s, atribucion = %s, url_base = 'https://www.indec.gob.ar/ipc' "
                          "WHERE id = 'INDEC_IPC'", LICENCIA)

    def aprobado(self, respuestas=None, **opciones):
        """Un candidato que pasa la revisión y se publica. Devuelve el resultado de publicar."""
        candidato = self.candidato(respuestas, hallazgos=[B], **opciones)
        self.aceptar_todos(candidato)
        return self.publicar(candidato)

    def exportar(self):
        return exportacion.exportar(self.conn, self.destino)

    def bytes_de(self, *partes):
        return (self.destino.joinpath(*partes)).read_bytes()

    def manifiesto(self, release_id):
        return json.loads(self.bytes_de("releases", release_id, "manifiesto.json"))

    def foto(self):
        """Todos los archivos de la copia con su contenido y fecha de modificación."""
        return {p.relative_to(self.destino).as_posix(): (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(self.destino.rglob("*")) if p.is_file()}


class ExportarTests(BaseExportacion):
    def test_un_release_aprobado_sale_con_un_csv_por_serie_y_su_manifiesto(self):
        publicado = self.aprobado()
        resultado = self.exportar()
        self.assertEqual((resultado["exportados"], resultado["pendientes"], resultado["errores"]), ([publicado.release_id], [], []))
        self.assertEqual(resultado["vigentes"], {"INDEC_IPC": publicado.release_id})
        m = self.manifiesto(publicado.release_id)
        self.assertEqual((m["schema_version"], m["release_id"], m["release_number"], m["source_id"], m["content_sha256"]),
                         (1, publicado.release_id, publicado.release_numero, "INDEC_IPC", publicado.hash_contenido))
        self.assertEqual((m["license"], m["license_url"], m["attribution"], m["source_url"]), (*LICENCIA, "https://www.indec.gob.ar/ipc"))
        self.assertEqual(len(m["series"]), 7)
        gba = next(s for s in m["series"] if s["id"] == "ipc_ng_gba")
        self.assertEqual((gba["name"], gba["unit"], gba["frequency"], gba["start"], gba["end"], gba["count"], gba["csv"]),
                         ("IPC nivel general - Gran Buenos Aires", "Índice", "Mensual", "2026-03-01", "2026-08-01", 6, "ipc_ng_gba.csv"))
        self.assertEqual((gba["sheet"], gba["source_row"], gba["file"]), ("Índices aperturas", 10, "sh_ipc_aperturas.xls"))
        csv = self.bytes_de("releases", publicado.release_id, "ipc_ng_gba.csv").decode()
        self.assertEqual(csv.splitlines()[:3], ["fecha,valor", "2026-03-01,100", "2026-04-01,101"])
        self.assertEqual(gba["sha256"], exportacion._sha256(csv.encode()))
        self.assertEqual([e["file"] for e in m["inputs"]], ["sh_ipc_09_26.xls", "sh_ipc_aperturas.xls"])
        self.assertEqual(set(m["inputs"][0]), {"file", "url", "sha256", "retrieved_at", "http_last_modified", "published_at"})
        self.assertEqual(exportacion.comprobar(self.destino), [])

    def test_lo_exportado_da_el_hash_que_se_aprobo(self):
        publicado = self.aprobado()
        self.exportar()
        filas = []
        for serie in self.manifiesto(publicado.release_id)["series"]:
            contenido = self.bytes_de("releases", publicado.release_id, serie["csv"])
            filas += [(serie["id"], p, v) for p, v in exportacion._leer_csv(contenido, serie["csv"])]
        self.assertEqual(hash_contenido(filas), publicado.hash_contenido)

    def test_no_sale_nada_que_no_este_publicado_ni_quien_aprobo(self):
        publicado = self.aprobado()
        self.candidato(self.mes_nuevo(), hallazgos=[B], valor=200)  # un candidato abierto, sin publicar
        self.exportar()
        self.assertEqual(sorted(p.name for p in (self.destino / "releases").iterdir()), [publicado.release_id])
        todo = b"".join(contenido for contenido, _ in self.foto().values()).decode()
        for ajeno in ("juani", "Revisado", "fecha_normalizada", "2026-03-01,200"):
            self.assertNotIn(ajeno, todo)

    def test_repetirlo_no_cambia_nada(self):
        self.aprobado()
        self.exportar()
        antes = self.foto()
        resultado = self.exportar()
        self.assertEqual((resultado["exportados"], resultado["ya_estaban"]), ([], 1))
        self.assertEqual(self.foto(), antes)  # ni el contenido ni la fecha de ningún archivo

    def test_un_release_nuevo_se_suma_y_pasa_a_ser_el_vigente_sin_tocar_el_anterior(self):
        primero = self.aprobado()
        self.exportar()
        anterior = {k: v for k, v in self.foto().items() if k.startswith(f"releases/{primero.release_id}/")}
        segundo = self.aprobado(self.mes_nuevo(), valor=200)
        resultado = self.exportar()
        self.assertEqual((resultado["exportados"], resultado["vigentes"]), ([segundo.release_id], {"INDEC_IPC": segundo.release_id}))
        self.assertEqual({k: v for k, v in self.foto().items() if k.startswith(f"releases/{primero.release_id}/")}, anterior)
        self.assertIn("2026-03-01,100\n", self.bytes_de("releases", primero.release_id, "ipc_ng_gba.csv").decode())  # el viejo, como se aprobó
        self.assertIn("2026-03-01,200\n", self.bytes_de("releases", segundo.release_id, "ipc_ng_gba.csv").decode())
        catalogo = json.loads(self.bytes_de("catalogo.json"))
        self.assertEqual([r["release_id"] for r in catalogo["releases"]], [primero.release_id, segundo.release_id])
        self.assertEqual(catalogo["sources"]["INDEC_IPC"]["current"], segundo.release_id)

    def test_el_vigente_es_el_ultimo_publicado_y_no_el_que_ordena_primero_o_ultimo_por_nombre(self):
        from datetime import date

        from servicio_datos import publicacion
        publicados = []
        for vuelta, (dia, valor) in enumerate(((date(2026, 1, 1), 100), (date(2026, 12, 1), 200), (date(2026, 6, 1), 300))):
            archivos = {**self.publicado, NAC["10"]: xls(f"nacional-10-{vuelta}")} if vuelta else None  # cada vuelta, un archivo nuevo
            candidato = self.candidato(archivos, hallazgos=[B], valor=valor)
            self.aceptar_todos(candidato)
            publicados.append(publicacion.publicar_candidato(self.conn, candidato, "juani", fecha=dia).release_id)
        nombres = sorted(publicados)
        self.assertNotIn(publicados[-1], (nombres[0], nombres[-1]))  # el último publicado queda en el medio por nombre
        self.assertEqual(self.exportar()["vigentes"], {"INDEC_IPC": publicados[-1]})

    def test_toda_la_historia_sale_aunque_se_exporte_por_primera_vez_despues(self):
        primero, segundo = self.aprobado(), self.aprobado(self.mes_nuevo(), valor=200)
        self.assertEqual(self.exportar()["exportados"], [primero.release_id, segundo.release_id])
        self.assertIn("2026-03-01,100\n", self.bytes_de("releases", primero.release_id, "ipc_ng_gba.csv").decode())
        self.assertEqual(exportacion.comprobar(self.destino), [])


class LoQueNoSaleTests(BaseExportacion):
    def test_sin_licencia_revisada_la_fuente_no_se_exporta(self):
        publicado = self.aprobado()
        self.conn.execute("UPDATE fuente SET atribucion = NULL WHERE id = 'INDEC_IPC'")
        resultado = self.exportar()
        self.assertEqual(resultado["exportados"], [])
        self.assertEqual(resultado["pendientes"], [{"release_id": publicado.release_id,
                                                    "motivo": "La fuente INDEC_IPC no tiene licencia y atribución revisadas: no se redistribuye"}])
        self.assertEqual(json.loads(self.bytes_de("catalogo.json"))["releases"], [])

    def test_si_lo_reconstruido_no_da_el_hash_aprobado_no_sale(self):
        publicado = self.aprobado()
        self.conn.execute("INSERT INTO observacion (serie_id, periodo, valor, release_desde) VALUES ('ipc_ng_gba', '2030-01-01', 1, %s)",
                          (publicado.release_numero,))
        resultado = self.exportar()
        self.assertEqual(resultado["exportados"], [])
        self.assertIn("no da el hash que se aprobó", resultado["pendientes"][0]["motivo"])
        self.assertFalse((self.destino / "releases" / publicado.release_id).exists())

    def test_si_el_nuevo_no_puede_salir_el_catalogo_sigue_anunciando_el_anterior(self):
        primero = self.aprobado()
        self.exportar()
        segundo = self.aprobado(self.mes_nuevo(), valor=200)
        self.conn.execute("INSERT INTO observacion (serie_id, periodo, valor, release_desde) VALUES ('ipc_ng_gba', '2030-01-01', 1, %s)",
                          (segundo.release_numero,))
        resultado = self.exportar()
        self.assertEqual((resultado["vigentes"], len(resultado["pendientes"])), ({"INDEC_IPC": primero.release_id}, 1))

    def test_una_corrida_cortada_no_se_anuncia_y_la_siguiente_la_rehace(self):
        publicado = self.aprobado()
        # Se corta a mitad de camino y sin poder limpiar (como si se apagara la máquina): quedan los CSV, sin manifiesto.
        with patch.object(exportacion, "_json", side_effect=[OSError("disco lleno")]), patch.object(exportacion.shutil, "rmtree"), \
                self.assertRaises(OSError):
            self.exportar()
        restos = [p.name for p in (self.destino / "releases").iterdir()]
        self.assertNotIn(publicado.release_id, restos)  # lo a medias no queda con el nombre del release
        self.assertTrue(all(r.startswith(".") and r.endswith(".tmp") for r in restos), restos)
        self.assertFalse((self.destino / "catalogo.json").exists())
        self.assertEqual(self.exportar()["exportados"], [publicado.release_id])
        self.assertEqual(exportacion.comprobar(self.destino), [])

    def test_una_copia_alterada_no_se_pisa_ni_se_anuncia(self):
        publicado = self.aprobado()
        self.exportar()
        csv = self.destino / "releases" / publicado.release_id / "ipc_ng_gba.csv"
        csv.write_text(csv.read_text().replace("2026-03-01,100", "2026-03-01,999"))
        errores = exportacion.comprobar(self.destino)
        self.assertTrue(any("ipc_ng_gba.csv no coincide con el SHA-256" in e for e in errores), errores)
        resultado = self.exportar()
        self.assertIn("no coincide con su manifiesto", resultado["pendientes"][0]["motivo"])
        self.assertIn("2026-03-01,999", csv.read_text())  # no la reescribe: que la mire una persona
        self.assertEqual(json.loads(self.bytes_de("catalogo.json"))["releases"], [])


class ComprobarTests(BaseExportacion):
    def setUp(self):
        super().setUp()
        self.publicado = self.aprobado()
        self.exportar()
        self.carpeta = self.destino / "releases" / self.publicado.release_id

    def test_detecta_lo_que_falta_sobra_o_no_coincide(self):
        (self.carpeta / "extra.txt").write_text("hola")
        (self.carpeta / "ipc_ng_cuyo.csv").unlink()
        errores = exportacion.comprobar(self.destino)
        self.assertTrue(any("falta ipc_ng_cuyo.csv" in e for e in errores), errores)
        self.assertTrue(any("archivos que el manifiesto no nombra: extra.txt" in e for e in errores), errores)
        self.assertIn("catalogo.json no corresponde a los releases que hay en la copia", errores)

    def test_un_manifiesto_retocado_a_mano_no_pasa(self):
        manifiesto = json.loads((self.carpeta / "manifiesto.json").read_text())
        csv = self.carpeta / "ipc_ng_gba.csv"
        csv.write_text(csv.read_text().replace("2026-03-01,100", "2026-03-01,999"))
        next(s for s in manifiesto["series"] if s["id"] == "ipc_ng_gba")["sha256"] = exportacion._sha256(csv.read_bytes())
        (self.carpeta / "manifiesto.json").write_bytes(exportacion._json(manifiesto))
        self.assertTrue(any("no da el hash que se aprobó" in e for e in exportacion.comprobar(self.destino)))

    def test_un_manifiesto_no_puede_hacer_leer_fuera_de_su_carpeta(self):
        manifiesto = json.loads((self.carpeta / "manifiesto.json").read_text())
        manifiesto["series"][0]["csv"] = "../../catalogo.json"
        (self.carpeta / "manifiesto.json").write_bytes(exportacion._json(manifiesto))
        self.assertTrue(any("no es un CSV de serie" in e for e in exportacion.comprobar(self.destino)))


class LineaDeComandosTests(BaseExportacion):
    def cli(self, *args, entorno=None):
        salida, errores = io.StringIO(), io.StringIO()
        with patch.dict(os.environ, entorno if entorno is not None else {"DATOS_EXPORTACION_DATABASE_URL": self.url_esquema()}, clear=True), \
                contextlib.redirect_stdout(salida), contextlib.redirect_stderr(errores):
            codigo = exportar.main(list(args))
        return codigo, salida.getvalue(), errores.getvalue()

    def url_esquema(self):
        return f"{URL}{'&' if '?' in URL else '?'}options=-csearch_path%3D{self.schema}%2Cpublic"

    def test_exporta_y_comprueba(self):
        publicado = self.aprobado()
        codigo, salida, errores = self.cli("--destino", str(self.destino))
        self.assertEqual(codigo, 0, errores)
        self.assertEqual(json.loads(salida)["exportados"], [publicado.release_id])
        self.assertEqual(self.cli("comprobar", "--destino", str(self.destino), entorno={})[0], 0)

    def test_lo_pendiente_sale_con_codigo_1_y_dice_por_que(self):
        self.aprobado()
        self.conn.execute("UPDATE fuente SET licencia = NULL WHERE id = 'INDEC_IPC'")
        codigo, _, errores = self.cli("--destino", str(self.destino))
        self.assertEqual(codigo, 1)
        self.assertIn("no tiene licencia y atribución revisadas", errores)

    def test_alcanza_con_el_rol_de_los_respaldos(self):
        import uuid

        import psycopg
        from psycopg.conninfo import make_conninfo

        from servicio_datos import respaldo
        publicado = self.aprobado()
        rol = "t_exporta_" + uuid.uuid4().hex[:8]

        def borrar():
            with psycopg.connect(URL, autocommit=True) as conn:
                conn.execute(f"DROP OWNED BY {rol}; DROP ROLE IF EXISTS {rol}")
        self.addCleanup(borrar)
        for sentencia in respaldo.sql_del_rol(rol, self.schema, "postgres").split(";"):
            codigo = "\n".join(linea for linea in sentencia.splitlines() if not linea.startswith("--")).strip()
            if codigo:
                self.conn.execute(codigo)
        codigo, salida, errores = self.cli("--destino", str(self.destino), entorno={"DATOS_EXPORTACION_DATABASE_URL": make_conninfo(URL, user=rol)})
        self.assertEqual(codigo, 0, errores)
        self.assertEqual(json.loads(salida)["exportados"], [publicado.release_id])

    def test_sin_url_no_arranca(self):
        codigo, _, errores = self.cli("--destino", str(self.destino), entorno={})
        self.assertEqual(codigo, 1)
        self.assertIn("Falta DATOS_EXPORTACION_DATABASE_URL", errores)
