"""Pruebas de la importación candidata a Supabase, sin necesitar credenciales."""
import copy
import hashlib
import io
import re
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts import cargar_supabase


class SupabaseLoadTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pilot = cargar_supabase.prepare_pilot()

    def test_preflight_is_the_audited_pilot(self):
        self.assertEqual(self.pilot.pilot_id, "economia-piloto-ab569b5998c1")
        self.assertEqual(len(self.pilot.originals), 5)
        self.assertEqual(sum(len(source.series) for source in self.pilot.sources), 8)
        self.assertEqual(self.pilot.observation_count, 851)
        by_source = {source.source_id: source for source in self.pilot.sources}
        self.assertEqual(by_source["INDEC_IPC"].observation_count, 819)
        self.assertEqual(len(by_source["INDEC_IPC"].findings), 19)
        self.assertEqual(by_source["TOP_MENSUAL"].observation_count, 32)
        self.assertEqual(len(by_source["TOP_MENSUAL"].findings), 6)
        for original in self.pilot.originals:
            self.assertEqual(hashlib.sha256(original.path.read_bytes()).hexdigest(), original.sha256)
            self.assertEqual(original.storage_path, f"{original.sha256[:2]}/{original.sha256}{original.path.suffix}")

    def test_refuses_a_snapshot_that_no_longer_matches_the_originals(self):
        changed = copy.deepcopy(cargar_supabase.preparar_piloto.build())
        changed["series"][0]["observations"][0]["value"] = 999
        with mock.patch.object(cargar_supabase.preparar_piloto, "build", return_value=changed):
            with self.assertRaisesRegex(cargar_supabase.LoadError, "no coincide"):
                cargar_supabase.prepare_pilot()

    def test_existing_storage_object_is_downloaded_and_verified(self):
        original = self.pilot.originals[0]
        conflict = urllib.error.HTTPError(
            "https://example.test/upload", 409, "Conflict", {},
            io.BytesIO(b'{"message":"The resource already exists"}'),
        )
        with mock.patch("urllib.request.urlopen", side_effect=[conflict, io.BytesIO(original.path.read_bytes())]) as opened:
            result = cargar_supabase.upload_original(original, "https://example.test", "secret", "private")
        self.assertEqual(result, "existente_verificado")
        self.assertIn("/object/authenticated/private/", opened.call_args_list[1].args[0].full_url)

    def test_refuses_an_existing_storage_object_with_wrong_content(self):
        original = self.pilot.originals[0]
        conflict = urllib.error.HTTPError(
            "https://example.test/upload", 400, "Bad Request", {},
            io.BytesIO(b'{"message":"Duplicate"}'),
        )
        with mock.patch("urllib.request.urlopen", side_effect=[conflict, io.BytesIO(b"alterado")]):
            with self.assertRaisesRegex(cargar_supabase.LoadError, "no coincide"):
                cargar_supabase.upload_original(original, "https://example.test", "secret", "private")

    def test_loader_has_no_write_to_published_tables(self):
        source = Path(cargar_supabase.__file__).read_text(encoding="utf-8")
        forbidden = re.compile(r"\b(?:insert\s+into|update|delete\s+from)\s+(?:release|observacion)\b", re.IGNORECASE)
        self.assertIsNone(forbidden.search(source))


if __name__ == "__main__":
    unittest.main()
