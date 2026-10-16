"""Coteja la ampliación TOP con todas las celdas originales, sin red ni credenciales."""
import csv
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import importar_top, preparar_piloto, top_provincial

MANIFEST = ROOT / "datos/originales/top_candidato_20261015T202113657342Z.json"


class TopImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = importar_top.build(MANIFEST)
        cls.top = {s["id"]: s for s in cls.bundle["series"] if s["source_id"] == "TOP_MENSUAL"}

    def test_all_773_observations_match_official_source_cells(self):
        checked = 0
        self.assertEqual(len(self.top), 24)
        for entry in json.loads(MANIFEST.read_text())["files"]:
            path = MANIFEST.parent / entry["file"]
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), entry["sha256"])
            book = openpyxl.load_workbook(path, read_only=True, data_only=True)
            try:
                rows = list(book["TOTAL"].values)
            finally:
                book.close()
            self.assertEqual(rows[3][1], "en millones de pesos")
            for suffix, label in importar_top.JURISDICTIONS.items():
                with self.subTest(year=entry["year"], jurisdiction=label):
                    series = self.top[f"top_mensual_{suffix}"]
                    original = next(o for o in series["originals"] if o["file"] == entry["file"])
                    row = rows[original["source_row"] - 1]
                    self.assertEqual(row[1], label)
                    expected = [{"date": f"{entry['year']}-{month:02d}-01", "value": value}
                                for month, value in enumerate(row[2:14], 1) if value not in (None, 0)]
                    actual = [o for o in series["observations"] if o["date"].startswith(str(entry["year"]))]
                    self.assertEqual(actual, expected)
                    self.assertEqual(series["unit"], "Millones de ARS corrientes")
                    self.assertEqual(original["sha256"], entry["sha256"])
                    self.assertIsNone(original["published_at"])
                    checked += len(expected)
        self.assertEqual(checked, 773)
        self.assertEqual(sum(s["available"] for s in self.bundle["series"]), 31)
        self.assertEqual(sum(s["count"] for s in self.bundle["series"]), 1592)

    def test_missing_month_and_different_publication_lags_are_preserved(self):
        pampa = self.top["top_mensual_la_pampa"]
        self.assertEqual(pampa["missing_periods"], ["2024-12-01"])
        self.assertNotIn("2024-12-01", {o["date"] for o in pampa["observations"]})
        self.assertTrue(any("2024-12-01" in note for note in pampa["normalization_notes"]))
        self.assertEqual(pampa["end"], "2026-07-01")
        self.assertEqual(self.top["top_mensual_catamarca"]["end"], "2026-09-01")
        self.assertEqual(self.top["top_mensual_cordoba"]["end"], "2026-08-01")
        # El modo auditado sigue rechazando el hueco: la ampliación lo admite
        # solamente con allow_gaps=True y lo documenta sin imputar valores.
        with self.assertRaisesRegex(ValueError, "huecos"):
            top_provincial.load(MANIFEST, "La Pampa")

    def test_legacy_audited_bundle_and_ipc_are_unchanged(self):
        previous = json.loads((ROOT / "datos/piloto/catalogo.json").read_text())
        self.assertEqual(preparar_piloto.build(), previous)
        self.assertEqual(previous["release_id"], "economia-piloto-ab569b5998c1")
        old_ipc = [s for s in previous["series"] if s["source_id"] == "INDEC_IPC"]
        self.assertEqual([s for s in self.bundle["series"] if s["source_id"] == "INDEC_IPC"], old_ipc)
        self.assertEqual(importar_top.build(MANIFEST), self.bundle)

    def test_csv_keeps_value_and_cell_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory)
            importar_top.write_exports(self.bundle, destination)
            with (destination / "top_mensual.csv").open(newline="") as stream:
                rows = list(csv.DictReader(stream))
            self.assertEqual(len(rows), 773)
            for row in rows:
                series = self.top[row["serie_id"]]
                point = next(o for o in series["observations"] if o["date"] == row["periodo"])
                self.assertEqual(float(row["valor"]), point["value"])
                original = next(o for o in series["originals"] if o["file"] == row["archivo"])
                self.assertEqual(row["sha256"], original["sha256"])
                self.assertEqual(row["celda"], chr(ord("B") + int(row["periodo"][5:7])) + str(original["source_row"]))
            self.assertEqual(json.loads((destination / "catalogo.json").read_text()), self.bundle)


if __name__ == "__main__":
    unittest.main()
