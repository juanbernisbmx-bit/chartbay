"""Prueba la importación masiva, las revisiones y la procedencia sin red."""
import csv
import hashlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import consultar_base, importar_masivo as importer, recolectar_masivo as collector


class MassiveImportTests(unittest.TestCase):
    def fixture(self, root):
        files = []

        def preserve(body, extension, kind, **extra):
            sha256 = hashlib.sha256(body).hexdigest()
            path = root / (sha256 + extension)
            path.write_bytes(body)
            entry = {"kind": kind, "url": "https://apis.datos.gob.ar/" + kind,
                     "file": path.name, "sha256": sha256, "bytes": len(body),
                     "status": "descargado", **extra}
            files.append(entry)
            return entry

        def csv_bytes(headers, rows):
            stream = io.StringIO(newline="")
            writer = csv.writer(stream)
            writer.writerow(headers)
            writer.writerows(rows)
            return stream.getvalue().encode()

        def zip_values(rows):
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w") as archive:
                archive.writestr("series-tiempo-valores.csv", csv_bytes(
                    ["catalogo_id", "dataset_id", "distribucion_id", "serie_id", "indice_tiempo", "valor", "indice_tiempo_frecuencia"], rows))
            return stream.getvalue()

        preserve(csv_bytes(["catalogo_id", "serie_id", "serie_titulo", "serie_unidades", "indice_tiempo_frecuencia", "serie_valores_cant"],
                           [["economia", "a", "Índice A", "pesos", "R/P1M", "2"],
                            ["economia", "b", "Índice B", "pesos", "R/P1M", "1"]]), ".csv", "metadatos")
        preserve(zip_values([["economia", "1", "1.1", "a", "2020-01-01", "1.00", "R/P1M"],
                             ["economia", "1", "1.1", "a", "2020-02-01", "0", "R/P1M"]]), ".zip", "valores")
        preserve(zip_values([["economia", "1", "1.1", "a", "2020-01-01", "1.00", "R/P1M"],
                             ["economia", "1", "1.1", "a", "2020-01-01", "2.000", "R/P1M"],
                             ["economia", "1", "1.1", "c", "2020-02-01", "", "R/P1M"]]), ".zip", "valores_catalogo", catalogo_id="economia")
        preserve('"a";"";""\n"01";"1,200";""\n'.encode(), ".csv", "recurso")
        manifest = root / "manifiesto.json"
        manifest.write_text(json.dumps({"schema_version": 1, "completed_at": "2026-10-15T00:00:00Z", "files": files}))
        return manifest

    def test_keeps_raw_precision_conflicting_values_zero_and_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = self.fixture(root)
            result = importer.build(manifest, root / "out")
            with consultar_base.connect(root / "out/economia.sqlite") as connection:
                self.assertEqual(result["registros_con_procedencia"], 5)
                self.assertEqual(result["observaciones"], 3)
                self.assertEqual(result["registros_faltantes_conservados"], 1)
                self.assertEqual(result["series_con_observaciones"], 1)
                self.assertEqual(result["series_catalogadas"], 3)
                self.assertEqual(result["series_sin_ficha"], 1)
                self.assertEqual(result["periodos_duplicados_conservados"], 1)
                self.assertEqual({row[0] for row in connection.execute("SELECT valor FROM valores")}, {"1.00", "2.000", "0", ""})
                row = connection.execute("SELECT celdas_json FROM fila_csv").fetchone()
                self.assertEqual(json.loads(row[0]), ["01", "1,200", ""])
                self.assertEqual(json.loads(connection.execute("SELECT encabezados_json FROM recurso_csv").fetchone()[0]), ["a", "", ""])
                self.assertEqual(consultar_base.search(connection, "Índice A")[0]["serie_id"], "a")
                with self.assertRaises(sqlite3.OperationalError):
                    connection.execute("DELETE FROM serie")
                consultar_base.export(connection, "economia", "a", root / "a.csv")
                with (root / "a.csv").open(newline="") as stream:
                    rows = list(csv.DictReader(stream))
                self.assertEqual(len(rows), 3)
                self.assertTrue((root / "a.ficha.json").is_file())
            # Repetir genera la misma cobertura y no acumula filas.
            again = importer.build(manifest, root / "out")
            self.assertEqual(again["observaciones"], result["observaciones"])

    def test_hash_mismatch_never_replaces_existing_database(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = self.fixture(root)
            destination = root / "out"
            importer.build(manifest, destination)
            before = hashlib.sha256((destination / "economia.sqlite").read_bytes()).hexdigest()
            entry = json.loads(manifest.read_text())["files"][0]
            (root / entry["file"]).write_bytes(b"alterado")
            with self.assertRaisesRegex(ValueError, "hash"):
                importer.build(manifest, destination)
            self.assertEqual(hashlib.sha256((destination / "economia.sqlite").read_bytes()).hexdigest(), before)

    def test_bad_zip_member_and_path_escape_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "bad.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("../escape.csv", "data")
            with self.assertRaisesRegex(ValueError, "esperado"):
                with importer.values_reader(path):
                    pass
            with self.assertRaisesRegex(ValueError, "Nombre"):
                importer.verified_file(Path(folder) / "m.json", {"file": "../otro.csv"})

    def test_collector_checks_https_domains_and_real_file_links(self):
        for url in ["http://www.argentina.gob.ar/data.csv", "https://www.argentina.gob.ar.evil.test/a.csv",
                    "https://secret@www.argentina.gob.ar/a.csv", "https://127.0.0.1/a.csv"]:
            self.assertFalse(collector.official(url))
        self.assertTrue(collector.official("https://datos.yvera.gob.ar/serie.csv"))
        html = '<a href="blank:#/a.csv">CSV</a><a href="http://www.mecon.gob.ar/a.xlsx">XLSX</a><a href="https://evil.test/a.csv">x</a>'
        self.assertEqual(collector.resource_links(html, "https://www.argentina.gob.ar/page"),
                         ["https://www.argentina.gob.ar/a.csv", "https://www.mecon.gob.ar/a.xlsx"])


if __name__ == "__main__":
    unittest.main()
