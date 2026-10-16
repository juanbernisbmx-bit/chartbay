"""Local economic catalogue routes, without network or scientific dependencies."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from web.app import app, SECCIONES
from web.economic_database import read_snapshot


class EconomicDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def test_catalogue_has_real_observations_only_for_loaded_series(self):
        response = self.client.get('/api/base-datos/catalogo')
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(len(payload['series']), 100)
        loaded = [s for s in payload['series'] if s['available']]
        self.assertEqual(len(loaded), 31)
        self.assertEqual(sum(s['count'] for s in loaded), 1592)
        for series in payload['series']:
            self.assertEqual(series['count'], len(series['observations']))
            self.assertEqual(series['available'], bool(series['observations']))
            if series['available']:
                self.assertEqual(len(series['original']['sha256']), 64)
                expected_host = 'https://www.indec.gob.ar/' if series['source_id'] == 'INDEC_IPC' else 'https://www.argentina.gob.ar/'
                self.assertTrue(series['original']['url'].startswith(expected_host))

    def test_page_navigation_and_security_headers(self):
        response = self.client.get('/base-de-datos')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'chartbay.database.js', response.data)
        self.assertIn(b'Content-Security-Policy', str(response.headers).encode())
        self.assertIn(b'/base-de-datos', self.client.get('/econometria').data)

    def test_missing_snapshot_returns_actionable_503(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, CHARTBAY_DATA_DIR=directory):
            response = self.client.get('/api/base-datos/catalogo')
            self.assertEqual(response.status_code, 503)
            self.assertFalse(response.get_json()['ok'])

    def test_duplicate_ids_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, CHARTBAY_DATA_DIR=directory):
            (Path(directory) / 'catalogo.json').write_text(json.dumps({'schema_version': 1, 'series': [{'id': 'a'}, {'id': 'a'}]}))
            with self.assertRaises(ValueError):
                read_snapshot(ROOT)

    def test_flag_disables_page_and_api(self):
        with patch.dict(SECCIONES, base_datos=False):
            self.assertEqual(self.client.get('/base-de-datos').status_code, 404)
            self.assertEqual(self.client.get('/api/base-datos/catalogo').status_code, 404)

    def test_invalid_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, CHARTBAY_DATA_DIR=directory):
            (Path(directory) / 'catalogo.json').write_text('null')
            with self.assertRaises(ValueError):
                read_snapshot(ROOT)


if __name__ == '__main__':
    unittest.main()
