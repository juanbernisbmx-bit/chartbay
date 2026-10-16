"""Fixtures offline: archivos reales, expectativas independientes y fallos de red."""
import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import URLError

import xlrd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import ipc_indec as ipc, preparar_piloto as pilot, recolectar_ipc as collector

FIXTURES = ROOT / "tests/fixtures/ipc"
ORIGINALS = ROOT / "datos/originales"
HTML = (FIXTURES / "indec.html").read_bytes()
EXPECTED = json.loads((FIXTURES / "expected.json").read_text())
URLS = collector.discover(HTML.decode())
NATIONAL = (ORIGINALS / "sh_ipc_09_26.xls").read_bytes()
REGIONAL = (ORIGINALS / "sh_ipc_aperturas.xls").read_bytes()
BASE = json.loads(ipc.BASELINE.read_bytes())


def response(url):
    body = {ipc.PAGE: HTML, URLS["nacional"]: NATIONAL, URLS["regiones"]: REGIONAL}[url]
    return body, {"url": url, "requested_url": url, "retrieved_at": "2026-10-13T18:00:00+00:00",
                  "published_at": None, "http_status": 200, "content_type": "application/vnd.ms-excel",
                  "http_last_modified_raw": "Thu, 10 Sep 2026 18:52:05 GMT",
                  "http_date_raw": "Tue, 13 Oct 2026 17:59:59 GMT"}


class IPCCandidateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.folder = Path(self.tmp.name)
        self.base_path = self.folder / "baseline.json"
        self.base_path.write_text(json.dumps(BASE), encoding="utf-8")

    def collect(self, fetch=response):
        with mock.patch.object(collector, "fetch", side_effect=fetch):
            path = collector.collect(self.folder / "raw", self.base_path)
        return path, json.loads(path.read_bytes())

    def test_extract_matches_independent_fixture_and_keeps_month_note(self):
        series = {}
        for role, file in (("nacional", "sh_ipc_09_26.xls"), ("regiones", "sh_ipc_aperturas.xls")):
            series.update(ipc.extract(ORIGINALS / file, role))
        ipc.check_series(series)
        self.assertEqual(set(series), set(EXPECTED["series"]))
        for key, expected in EXPECTED["series"].items():
            actual = series[key]
            self.assertEqual(actual["row"], expected["row"])
            self.assertEqual(len(actual["observations"]), EXPECTED["count"])
            self.assertEqual(actual["observations"][0], {"date": EXPECTED["start"], "value": 100})
            self.assertEqual(actual["observations"][-1], {"date": EXPECTED["end"], "value": expected["last_value"]})
            self.assertTrue(any("2026-03-26" in note for note in actual["notes"]))

    def test_collect_revalidate_deduplicate_and_preserve_pilot(self):
        paths = [ipc.BASELINE, ORIGINALS / "manifiesto.json", ORIGINALS / "top_manifest.json"]
        before = {p: p.read_bytes() for p in paths}
        path, manifest = self.collect()
        self.assertEqual(manifest["status"], "candidata")
        self.assertEqual(manifest["comparison"]["counts"], {"revisions": 0, "additions": 0, "removals": 0})
        self.assertEqual(len(manifest["attempts"]), 3)
        files, series = ipc.load_candidate(path, self.base_path)
        self.assertEqual(sum(len(s["observations"]) for s in series.values()), 819)
        mtimes = {}
        for entry in files:
            original = path.parent / entry["file"]
            self.assertEqual(ipc.digest(original.read_bytes()), entry["sha256"])
            mtimes[original] = original.stat().st_mtime_ns
            self.assertIsNone(entry["published_at"])
            self.assertEqual(entry["http_last_modified_at"], "2026-09-10T18:52:05+00:00")
            self.assertEqual(entry["retrieved_at"], "2026-10-13T18:00:00+00:00")
        second, _ = self.collect()
        self.assertNotEqual(second, path)
        self.assertEqual(mtimes, {p: p.stat().st_mtime_ns for p in mtimes})
        self.assertEqual(len(list(path.parent.glob("ipc_*.xls"))), 2)
        self.assertEqual(before, {p: p.read_bytes() for p in paths})

    def test_historical_revision_separate_from_seven_new_months(self):
        base = copy.deepcopy(BASE)
        for series in base["series"]:
            if series["id"] in ipc.IDS:
                series["observations"].pop()
            if series["id"] == "ipc_ng_nacional":
                series["observations"][1]["value"] = 999
        self.base_path.write_text(json.dumps(base))
        path, report = self.collect()
        self.assertEqual(report["status"], "candidata")
        self.assertEqual(report["comparison"]["counts"], {"revisions": 1, "additions": 7, "removals": 0})
        revision = report["comparison"]["revisions"][0]
        self.assertEqual((revision["series_id"], revision["date"], revision["previous"]),
                         ("ipc_ng_nacional", "2017-01-01", 999))
        self.assertNotEqual(revision["candidate"], 999)
        ipc.load_candidate(path, self.base_path)

    def test_stale_national_rejected_and_downloads_retained(self):
        def stale(url):
            body, meta = response(url)
            return ((ORIGINALS / "sh_ipc_08_26.xls").read_bytes() if url == URLS["nacional"] else body), meta
        path, report = self.collect(stale)
        self.assertEqual(report["status"], "rechazada")
        self.assertIn("desalineadas", report["errors"][0])
        self.assertEqual(len(list(path.parent.glob("ipc_*.xls"))), 2)
        with self.assertRaisesRegex(ValueError, "rechazado"):
            ipc.load_candidate(path, self.base_path)

    def test_aligned_regression_rejected_with_removal_detail(self):
        original_extract = ipc.extract
        def shorter(*args):
            series = original_extract(*args)
            for data in series.values():
                data["observations"].pop()
            return series
        with mock.patch.object(ipc, "extract", side_effect=shorter):
            _, report = self.collect()
        self.assertEqual(report["status"], "rechazada")
        self.assertEqual(report["comparison"]["counts"]["removals"], 7)
        self.assertIn("perdió meses", report["errors"][0])

    def test_failures_are_recorded_without_losing_first_download(self):
        def failing(url):
            if url == URLS["regiones"]:
                raise URLError("fixture timeout")
            return response(url)
        path, report = self.collect(failing)
        self.assertEqual(report["status"], "rechazada")
        self.assertEqual(report["attempts"][-1]["status"], "error")
        self.assertIn("fixture timeout", report["errors"][0])
        self.assertTrue((path.parent / report["files"][0]["file"]).is_file())
        _, failed_page = self.collect(lambda url: (_ for _ in ()).throw(URLError("offline")))
        self.assertEqual(len(failed_page["attempts"]), 1)
        self.assertEqual(failed_page["status"], "rechazada")

    def test_html_disguised_as_xls_is_preserved_but_rejected(self):
        def bad(url):
            body, metadata = response(url)
            return (b"<html>Error</html>" if url == URLS["nacional"] else body), metadata
        path, report = self.collect(bad)
        self.assertEqual(report["status"], "rechazada")
        self.assertEqual((path.parent / report["files"][0]["file"]).read_bytes(), b"<html>Error</html>")

    def test_missing_http_dates_do_not_invent_publication(self):
        def missing(url):
            body, metadata = response(url)
            metadata.update(http_last_modified_raw=None, http_date_raw=None)
            return body, metadata
        path, report = self.collect(missing)
        self.assertEqual(report["status"], "candidata")
        self.assertTrue(all(e["http_last_modified_at"] is None and e["published_at"] is None for e in report["files"]))
        ipc.load_candidate(path, self.base_path)

    def test_malformed_and_future_http_dates_rejected_after_preservation(self):
        for value in ("ayer", "Wed, 14 Oct 2026 18:00:00 GMT", "Thu, 10 Sep 2026 18:52:05"):
            with self.subTest(value=value):
                def invalid(url):
                    body, metadata = response(url)
                    metadata["http_last_modified_raw"] = value
                    return body, metadata
                path, report = self.collect(invalid)
                self.assertEqual(report["status"], "rechazada")
                self.assertTrue((path.parent / report["page"]["file"]).exists())

    def test_original_corruption_not_overwritten(self):
        path, report = self.collect()
        target = path.parent / report["files"][0]["file"]
        target.write_bytes(b"corrupto")
        with self.assertRaisesRegex(ValueError, "Original alterado"):
            ipc.load_candidate(path, self.base_path)
        _, second = self.collect()
        self.assertEqual(second["status"], "rechazada")
        self.assertEqual(target.read_bytes(), b"corrupto")

    def test_tampered_report_baseline_or_paths_rejected(self):
        path, report = self.collect()
        for field in ("series", "comparison", "file", "published_at", "role"):
            changed = copy.deepcopy(report)
            if field == "series":
                changed[field]["ipc_ng_nacional"]["observations"][1]["value"] += 1
            elif field == "comparison":
                changed[field]["counts"]["revisions"] = 1
            else:
                changed["files"][0][field] = {"file": "../baseline.json", "published_at": "2026-09-10", "role": "regiones"}[field]
            path.write_text(json.dumps(changed))
            with self.subTest(field=field), self.assertRaises(ValueError):
                ipc.load_candidate(path, self.base_path)
        path.write_text(json.dumps(report))
        self.base_path.write_text(self.base_path.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "Cambió el piloto"):
            ipc.load_candidate(path, self.base_path)

    def test_discovery_requires_unambiguous_official_pair(self):
        self.assertEqual(set(URLS), {"nacional", "regiones"})
        for html in ("", HTML.decode().replace("sh_ipc_aperturas.xls", "otro.xls"),
                     HTML.decode() + '<a href="/ftp/cuadros/economia/sh_ipc_10_26.xls">otro</a>'):
            with self.assertRaisesRegex(ValueError, "único XLS"):
                collector.discover(html)
        for url in ("http://www.indec.gob.ar/a", "https://evil.example/a",
                    "https://www.indec.gob.ar.evil.example/a", "https://user@www.indec.gob.ar/a"):
            with self.assertRaises(ValueError):
                ipc.official_url(url)

    def test_parser_rejects_structural_and_numeric_errors(self):
        for kind in ("region", "level", "missing_region", "basis", "unheaded", "duplicate_month", "gap", "text", "zero", "nan"):
            book = xlrd.open_workbook(ORIGINALS / "sh_ipc_09_26.xls")
            sheet = book.sheet_by_name(ipc.SPECS["nacional"][0])
            row = next(r for r in range(sheet.nrows) if sheet.cell_value(r, 0) == "Total nacional")
            level = 9
            if kind == "region":
                sheet._cell_values[0][0] = "Total nacional"
            elif kind == "missing_region":
                sheet._cell_values[row][0] = "Otra cobertura"
            elif kind == "level":
                sheet._cell_values[level + 1][0] = "Nivel general"
            elif kind == "basis":
                sheet._cell_values[1][0] = "Base 2026=100"
            elif kind == "unheaded":
                sheet._cell_types[row][2] = xlrd.XL_CELL_EMPTY
            elif kind in ("duplicate_month", "gap"):
                sheet._cell_values[row][2] = sheet._cell_values[row][1 if kind == "duplicate_month" else 3]
            elif kind == "text":
                sheet._cell_types[level][2] = xlrd.XL_CELL_TEXT
                sheet._cell_values[level][2] = "s/d"
            else:
                sheet._cell_values[level][2] = 0 if kind == "zero" else float("nan")
            with self.subTest(kind=kind), mock.patch.object(xlrd, "open_workbook", return_value=book):
                with self.assertRaises(ValueError):
                    ipc.extract(ORIGINALS / "sh_ipc_09_26.xls", "nacional")

    def test_missing_region_sheet_and_full_calendar_checks(self):
        with self.assertRaises(xlrd.XLRDError):
            ipc.extract(ORIGINALS / "sh_ipc_09_26.xls", "regiones")
        series = ipc.baseline_series(BASE)
        for kind in ("region", "interior", "start", "duplicate"):
            changed = copy.deepcopy(series)
            if kind == "region":
                del changed["ipc_ng_nea"]
            elif kind == "interior":
                del changed["ipc_ng_nea"]["observations"][5]
            elif kind == "start":
                del changed["ipc_ng_nea"]["observations"][0]
            else:
                changed["ipc_ng_nea"]["observations"].insert(5, changed["ipc_ng_nea"]["observations"][5])
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                ipc.check_series(changed)

    def test_transport_bounds_redirects_and_capture(self):
        response_mock = mock.MagicMock()
        response_mock.__enter__.return_value = response_mock
        response_mock.status = 200
        response_mock.geturl.return_value = URLS["nacional"]
        response_mock.headers = {"Last-Modified": "Thu, 10 Sep 2026 18:52:05 GMT"}
        response_mock.read.return_value = b"xls"
        with mock.patch.object(collector, "build_opener") as opener:
            opener.return_value.open.return_value = response_mock
            body, metadata = collector.fetch(URLS["nacional"])
            self.assertEqual(body, b"xls")
            self.assertIsNotNone(ipc.moment(metadata["retrieved_at"]).tzinfo)
            response_mock.read.assert_called_once_with(collector.MAX_BYTES + 1)
            response_mock.read.return_value = b"x" * 11
            with mock.patch.object(collector, "MAX_BYTES", 10), self.assertRaisesRegex(ValueError, "límite"):
                collector.fetch(URLS["nacional"])
            response_mock.status = 206
            with self.assertRaisesRegex(ValueError, "HTTP"):
                collector.fetch(URLS["nacional"])
        with self.assertRaises(ValueError):
            collector.OfficialRedirect().redirect_request(None, None, 302, "", {}, "https://evil.example/x.xls")

    def test_cli_check_offline_and_invalid_combinations_never_write(self):
        path, _ = self.collect()
        before = ipc.BASELINE.read_bytes()
        result = subprocess.run([sys.executable, str(ROOT / "scripts/recolectar_ipc.py"),
                                 "--check-candidate", str(path), "--baseline", str(self.base_path)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["publica"])
        for options in (("--check-ipc-candidate", str(path), "--chartbay", "/tmp"),
                        ("--check-top-candidate", "/tmp/top.json", "--promote-ipc-candidate", str(path))):
            result = subprocess.run([sys.executable, str(ROOT / "scripts/preparar_piloto.py"), *options],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
        self.assertEqual(ipc.BASELINE.read_bytes(), before)

    def test_manual_promotion_only_in_isolated_repository_with_backup(self):
        # Prueba el comando real sin escribir en el repositorio del usuario.
        repo = self.folder / "repo"
        shutil.copytree(ROOT / "scripts", repo / "scripts", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(ROOT / "catalogo", repo / "catalogo")
        shutil.copytree(ORIGINALS, repo / "datos/originales")
        target = repo / "datos/piloto/catalogo.json"
        target.parent.mkdir(parents=True)
        target.write_bytes(ipc.BASELINE.read_bytes())
        before = target.read_bytes()
        with mock.patch.object(collector, "fetch", side_effect=response):
            candidate = collector.collect(repo / "datos/originales/ipc", target)
        command = [sys.executable, str(repo / "scripts/preparar_piloto.py")]
        checked = subprocess.run([*command, "--check-ipc-candidate", str(candidate)], capture_output=True, text=True)
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(target.read_bytes(), before)
        promoted = subprocess.run([*command, "--promote-ipc-candidate", str(candidate)], capture_output=True, text=True)
        self.assertEqual(promoted.returncode, 0, promoted.stderr)
        self.assertEqual(json.loads(promoted.stdout)["observations"], 851)
        bundle = json.loads(target.read_bytes())
        self.assertNotEqual(bundle["release_id"], BASE["release_id"])
        backup = target.parent / "respaldos" / f"catalogo_{ipc.digest(before)}.json"
        self.assertEqual(backup.read_bytes(), before)
        self.assertEqual(next(s for s in bundle["series"] if s["id"] == "top_mensual_cordoba"),
                         next(s for s in BASE["series"] if s["id"] == "top_mensual_cordoba"))
        for entry in bundle["inputs"]:
            self.assertEqual(ipc.digest((repo / "datos/originales" / entry["file"]).read_bytes()), entry["sha256"])
        # La base cambió; una candidata revisada contra la base anterior ya no se promueve.
        retried = subprocess.run([*command, "--promote-ipc-candidate", str(candidate)], capture_output=True, text=True)
        self.assertNotEqual(retried.returncode, 0)
        self.assertEqual(bundle, json.loads(target.read_bytes()))


if __name__ == "__main__":
    unittest.main()
