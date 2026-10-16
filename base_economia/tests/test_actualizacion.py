"""Programación, actualización incremental, fallos y HTTP condicional, sin red."""
import hashlib
import io
import json
import sqlite3
import tempfile
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError

from scripts import actualizar_base as updater, importar_masivo as importer, recolectar_masivo as downloader
from scripts.bloqueo_base import database_lock
from tests import test_importacion_masiva as massive_tests

NOW = datetime(2026, 10, 15, 15, tzinfo=timezone.utc)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        manifest = massive_tests.MassiveImportTests().fixture(self.root)
        importer.build(manifest, self.root / "base")
        self.connection = sqlite3.connect(self.root / "base/economia.sqlite")
        self.state = updater.state_connection(self.root / "control.sqlite")
        self.addCleanup(self.connection.close)
        self.addCleanup(self.state.close)
        self.config = updater.load_config()
        self.job = {"id": "catalogo:economia", "type": "catalog", "catalogo_id": "economia",
                    "cada_horas": 24, "resources": [], "activo": True}
        patcher = mock.patch.object(downloader, "RAW", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def values_entry(self, value="3.000", extra="4.00"):
        text = ("catalogo_id,dataset_id,distribucion_id,serie_id,indice_tiempo,valor,indice_tiempo_frecuencia\n"
                f"economia,1,1.1,a,2020-01-01,{value},R/P1M\n"
                f"economia,1,1.1,a,2020-03-01,{extra},R/P1M\n")
        body = io.BytesIO()
        with zipfile.ZipFile(body, "w") as archive:
            archive.writestr("series-tiempo-valores.csv", text)
        raw = body.getvalue()
        sha256 = hashlib.sha256(raw).hexdigest()
        path = self.root / (sha256 + ".zip")
        path.write_bytes(raw)
        return {"kind": "valores_catalogo", "catalogo_id": "economia", "file": path.name,
                "sha256": sha256, "bytes": len(raw), "status": "descargado",
                "url": "https://apis.datos.gob.ar/nuevo.zip", "retrieved_at": NOW.isoformat()}

    def test_frequency_groups_and_config_changes_take_effect(self):
        self.assertEqual(updater.interval(["Anual", "Mensual"], self.config), 24)
        self.assertEqual(updater.interval(["R/P1D", "R/P1M"], self.config), 6)
        self.assertEqual(updater.interval(["R/P3M"], self.config), 168)
        self.state.execute("INSERT INTO trabajo VALUES(?,?,?,?,?,?,?)", (
            self.job["id"], NOW.isoformat(), NOW.isoformat(), (NOW + timedelta(days=7)).isoformat(), 0, "sin_cambios", None))
        self.state.commit()
        changed = {**self.job, "cada_horas": 6}
        plan = updater.schedule(changed, self.state, {}, NOW + timedelta(hours=7))
        self.assertTrue(plan["vencido"])
        self.assertEqual(updater.moment(plan["proxima_consulta"]), NOW + timedelta(hours=6))

    def test_seed_schedule_uses_all_resource_capture_dates(self):
        job = {**self.job, "resources": [{"url": "meta"}, {"url": "values"}]}
        previous = {"meta": {"retrieved_at": NOW.isoformat()}, "values": {"retrieved_at": NOW.isoformat()}}
        self.assertFalse(updater.schedule(job, self.state, previous, NOW)["vencido"])
        self.assertTrue(updater.schedule(job, self.state, previous, NOW + timedelta(days=1))["vencido"])
        self.assertTrue(updater.schedule(job, self.state, {"meta": previous["meta"]}, NOW)["vencido"])

    def test_incremental_changes_keep_history_and_repeated_file_is_idempotent(self):
        entry = self.values_entry()
        added = updater.ingest(self.connection, self.job, [entry])
        self.assertEqual(added, 2)
        values = {row[0] for row in self.connection.execute("SELECT valor FROM valores WHERE serie_id='a'")}
        self.assertEqual(values, {"1.00", "2.000", "3.000", "4.00", "0"})
        self.assertEqual(self.connection.execute("SELECT observaciones FROM cobertura WHERE serie_id='a'").fetchone()[0], 5)
        before = self.connection.execute("SELECT COUNT(*) FROM observacion").fetchone()[0]
        self.assertEqual(updater.ingest(self.connection, self.job, [entry]), 0)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM observacion").fetchone()[0], before)
        # Otro archivo con el mismo valor no vuelve a copiar el histórico.
        another = self.values_entry(value="3.000", extra="4.000")
        self.assertEqual(updater.ingest(self.connection, self.job, [another]), 1)
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM observacion").fetchone()[0], before + 1)

    def test_parse_failure_rolls_back_entire_source(self):
        before = self.connection.execute("SELECT COUNT(*) FROM observacion").fetchone()[0]
        bad = self.values_entry()
        path = self.root / bad["file"]
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("wrong.csv", "wrong")
        bad["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        with self.assertRaises(ValueError):
            updater.ingest(self.connection, self.job, [bad])
        self.assertEqual(self.connection.execute("SELECT COUNT(*) FROM observacion").fetchone()[0], before)
        self.assertIsNone(self.connection.execute("SELECT 1 FROM archivo WHERE sha256=?", (bad["sha256"],)).fetchone())
        self.assertIsNone(self.connection.execute("SELECT 1 FROM sqlite_temp_master WHERE name='observacion'").fetchone())

    def test_retry_backoff_keeps_success_and_recovery_clears_error(self):
        self.state.execute("INSERT INTO trabajo VALUES(?,?,?,?,?,?,?)", (
            self.job["id"], NOW.isoformat(), NOW.isoformat(), NOW.isoformat(), 0, "sin_cambios", None))
        self.state.commit()
        def failure(*args):
            raise OSError("fuente inaccesible")
        with mock.patch.object(updater, "utcnow", return_value=NOW):
            first = updater.run_job(self.connection, self.state, self.job, self.config, {}, NOW, failure)
            second = updater.run_job(self.connection, self.state, self.job, self.config, {}, NOW, failure)
        self.assertEqual(updater.moment(first["proxima_consulta"]), NOW + timedelta(hours=1))
        self.assertEqual(updater.moment(second["proxima_consulta"]), NOW + timedelta(hours=2))
        self.assertEqual(self.state.execute("SELECT ultimo_exito FROM trabajo").fetchone()[0], NOW.isoformat())
        with mock.patch.object(updater, "utcnow", return_value=NOW):
            result = updater.run_job(self.connection, self.state, self.job, self.config, {}, NOW,
                                     lambda *args: [self.values_entry()])
        self.assertEqual(result["estado"], "actualizado")
        self.assertEqual(tuple(self.state.execute("SELECT fallos,error FROM trabajo").fetchone()), (0, None))

    def test_304_requires_valid_local_original_and_keeps_validators(self):
        entry = {**self.values_entry(), "etag": '"abc"'}
        job = {**self.job, "resources": [{"kind": entry["kind"], "url": entry["url"]}]}
        previous = {entry["url"]: entry}
        with mock.patch.object(downloader, "collect_one", return_value={"status": "sin_cambios", "http_status": 304, "retrieved_at": NOW.isoformat()}):
            result = updater.download_resources(job, self.state, previous)
            self.assertEqual(result[0]["sha256"], entry["sha256"])
            self.assertEqual(result[0]["etag"], entry["etag"])
            (self.root / entry["file"]).write_bytes(b"alterado")
            with self.assertRaisesRegex(ValueError, "304"):
                updater.download_resources(job, self.state, previous)

    def test_shared_lock_rejects_second_writer(self):
        with database_lock(self.root / "base"):
            with self.assertRaisesRegex(RuntimeError, "en curso"):
                with database_lock(self.root / "base"):
                    pass
            with self.assertRaisesRegex(RuntimeError, "en curso"):
                importer.build(self.root / "inexistente.json", self.root / "base")

    def test_http_304_and_header_injection(self):
        error = HTTPError("https://apis.datos.gob.ar/a.csv", 304, "Not Modified", {}, None)
        opener = mock.Mock()
        opener.open.side_effect = error
        with mock.patch.object(downloader, "build_opener", return_value=opener):
            result = downloader.collect_one("https://apis.datos.gob.ar/a.csv", "recurso", validators={"etag": '"abc"'})
        self.assertEqual(result["status"], "sin_cambios")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.get_header("If-none-match"), '"abc"')
        with self.assertRaises(ValueError):
            downloader.conditional_headers({"etag": "a\r\nInjected: bad"})

    def test_current_indexes_refresh_without_changing_initial_report(self):
        updater.ingest(self.connection, self.job, [self.values_entry()])
        initial = (self.root / "base/informe_importacion.json").read_bytes()
        updater.export_status(self.connection, self.state, self.root / "base")
        status = json.loads((self.root / "base/estado_actualizacion.json").read_text())
        self.assertEqual(status["observaciones"], 5)
        self.assertEqual((self.root / "base/informe_importacion.json").read_bytes(), initial)
        self.assertIn("5", (self.root / "base/catalogo_series.csv").read_text())


if __name__ == "__main__":
    unittest.main()
