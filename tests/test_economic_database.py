"""Public catalogue only exposes releases approved in Supabase or its GitHub copy."""
import hashlib
import io
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
from web import economic_database
from web.economic_database import read_pilot_snapshot, read_snapshot


class EconomicDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()
        config = patch.dict(os.environ, SUPABASE_URL='', SUPABASE_PUBLISHABLE_KEY='', CHARTBAY_DATABASE_MODE='published')
        config.start()
        self.addCleanup(config.stop)
        economic_database._supabase_cache.clear()
        self.addCleanup(economic_database._supabase_cache.clear)

    def test_without_approved_release_there_are_no_public_series(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = read_snapshot(root)
        self.assertEqual(payload['series'], [])
        self.assertEqual(payload['source'], 'sin_publicaciones')

    def published_copy(self, directory):
        root = Path(directory)
        metadata = root / 'datasets/economia'
        metadata.mkdir(parents=True)
        release = metadata / 'publicado/releases/ipc-2026-10-08-abcd'
        release.mkdir(parents=True)
        csv = b'fecha,valor\n2026-07-01,100\n2026-08-01,105\n'
        content_hash = hashlib.sha256(b'ipc_ng_nacional|2026-07-01|100\nipc_ng_nacional|2026-08-01|105').hexdigest()
        (release / 'ipc_ng_nacional.csv').write_bytes(csv)
        manifest = {'schema_version': 1, 'release_id': release.name, 'source_id': 'INDEC_IPC',
                    'source': 'INDEC', 'source_url': 'https://www.indec.gob.ar/ipc',
                    'license': 'CC BY-SA 4.0', 'license_url': 'https://creativecommons.org/licenses/by-sa/4.0/',
                    'attribution': 'Fuente: INDEC', 'content_sha256': content_hash,
                    'inputs': [{'file': 'ipc.xls', 'url': 'https://www.indec.gob.ar/ipc.xls',
                    'sha256': 'a' * 64, 'retrieved_at': '2026-10-08T00:00:00Z', 'published_at': None}],
                    'series': [{'id': 'ipc_ng_nacional', 'name': 'IPC nacional', 'topic': 'Precios', 'level': 'Nacional',
                    'territory': 'Argentina', 'classification': 'IPC', 'frequency': 'Mensual', 'unit': 'Índice',
                    'basis': '2016=100', 'file': 'ipc.xls', 'sheet': 'IPC', 'source_row': 2,
                    'normalization_notes': [], 'start': '2026-07-01', 'end': '2026-08-01', 'count': 2,
                    'csv': 'ipc_ng_nacional.csv', 'sha256': hashlib.sha256(csv).hexdigest()}]}
        raw = json.dumps(manifest).encode()
        (release / 'manifiesto.json').write_bytes(raw)
        catalogue = {'schema_version': 1, 'sources': {'INDEC_IPC': {'current': release.name}},
                     'releases': [{'release_id': release.name, 'manifest': f'releases/{release.name}/manifiesto.json',
                                   'sha256': hashlib.sha256(raw).hexdigest()}]}
        (metadata / 'publicado/catalogo.json').write_text(json.dumps(catalogue))
        return root, release

    def test_github_copy_populates_only_approved_series(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.published_copy(directory)
            payload = read_snapshot(root)
        self.assertEqual(payload['source'], 'github')
        self.assertEqual(len(payload['series']), 1)
        loaded = [s for s in payload['series'] if s['available']]
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0]['observations'][1], {'date': '2026-08-01', 'value': 105.0})
        self.assertEqual(loaded[0]['release_id'], 'ipc-2026-10-08-abcd')
        self.assertEqual(loaded[0]['attribution'], 'Fuente: INDEC')

    def test_live_supabase_takes_priority_and_failure_uses_github(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.published_copy(directory)
            live = {'schema_version': 1, 'sources': [{'release_id': 'ipc-live-123', 'source_id': 'INDEC_IPC',
                    'source': 'INDEC', 'source_url': 'https://www.indec.gob.ar/ipc', 'license': 'CC BY-SA 4.0',
                    'attribution': 'Fuente: INDEC', 'inputs': [], 'series': [{'id': 'ipc_ng_nacional',
                    'name': 'IPC nacional', 'frequency': 'Mensual', 'start': '2026-08-01', 'end': '2026-08-01',
                    'count': 1, 'observations': [{'date': '2026-08-01', 'value': 110}]}]}]}
            with patch('web.economic_database.urlopen', return_value=io.BytesIO(json.dumps(live).encode())) as fetch:
                current = read_snapshot(root, 'https://supabase.example', 'sb_publishable_test')
                request = fetch.call_args.args[0]
                self.assertEqual(request.get_header('Apikey'), 'sb_publishable_test')
                self.assertFalse(request.has_header('Authorization'))
            economic_database._supabase_cache.clear()
            with patch('web.economic_database.urlopen', side_effect=OSError('offline')):
                fallback = read_snapshot(root, 'https://supabase.example', 'sb_publishable_test')
        self.assertEqual(current['source'], 'supabase')
        self.assertEqual(current['series'][0]['observations'][0]['value'], 110)
        self.assertEqual(fallback['source'], 'github')
        self.assertEqual(fallback['series'][0]['observations'][1]['value'], 105.0)

    def test_supabase_answers_are_cached_and_failures_wait_before_retrying(self):
        with tempfile.TemporaryDirectory() as directory:
            root, _ = self.published_copy(directory)
            live = json.dumps({'schema_version': 1, 'sources': []}).encode()
            args = (root, 'https://supabase.example', 'sb_publishable_test')
            with patch('web.economic_database.time.monotonic', return_value=1000.0), \
                 patch('web.economic_database.urlopen', side_effect=lambda *a, **k: io.BytesIO(live)) as fetch:
                self.assertEqual(read_snapshot(*args)['source'], 'github')
                self.assertEqual(read_snapshot(*args)['source'], 'github')
            self.assertEqual(fetch.call_count, 1)
            with patch('web.economic_database.time.monotonic', return_value=1000.0 + economic_database.SUPABASE_TTL), \
                 patch('web.economic_database.urlopen', side_effect=OSError('offline')) as fetch:
                self.assertEqual(read_snapshot(*args)['source'], 'github')
                self.assertEqual(read_snapshot(*args)['source'], 'github')
            self.assertEqual(fetch.call_count, 1)
            retry = 1000.0 + economic_database.SUPABASE_TTL + economic_database.SUPABASE_RETRY
            with patch('web.economic_database.time.monotonic', return_value=retry), \
                 patch('web.economic_database.urlopen', side_effect=lambda *a, **k: io.BytesIO(live)) as fetch:
                read_snapshot(*args)
            self.assertEqual(fetch.call_count, 1)

    def test_corrupt_copy_does_not_restore_pilot_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root, release = self.published_copy(directory)
            (release / 'ipc_ng_nacional.csv').write_text('fecha,valor\n2026-08-01,999\n')
            payload = read_snapshot(root)
        self.assertEqual(payload['source'], 'sin_publicaciones')
        self.assertEqual(payload['series'], [])

    def test_last_good_supabase_release_survives_an_outage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            live = {'schema_version': 1, 'sources': [{'release_id': 'ipc-live-123', 'source_id': 'INDEC_IPC',
                    'source': 'INDEC', 'license': 'CC BY-SA 4.0', 'attribution': 'Fuente: INDEC', 'series': [
                    {'id': 'ipc_ng_nacional', 'name': 'IPC nacional', 'frequency': 'Mensual', 'start': '2026-08-01',
                     'end': '2026-08-01', 'count': 1, 'observations': [{'date': '2026-08-01', 'value': 110}]}]}]}
            args = (root, 'https://supabase.example', 'sb_publishable_test')
            with patch('web.economic_database.time.monotonic', return_value=1000.0), \
                 patch('web.economic_database.urlopen', return_value=io.BytesIO(json.dumps(live).encode())):
                self.assertEqual(read_snapshot(*args)['source'], 'supabase')
            with patch('web.economic_database.time.monotonic', return_value=1000.0 + economic_database.SUPABASE_TTL), \
                 patch('web.economic_database.urlopen', side_effect=OSError('offline')) as fetch:
                stale = read_snapshot(*args)
                repeated = read_snapshot(*args)
            self.assertEqual(fetch.call_count, 1)
            self.assertEqual(stale['source'], 'supabase_cache')
            self.assertEqual(repeated['series'][0]['observations'][0]['value'], 110)

    def test_page_navigation_and_security_headers(self):
        response = self.client.get('/base-de-datos')
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'chartbay.database.js', response.data)
        self.assertIn(b'Content-Security-Policy', str(response.headers).encode())
        self.assertIn(b'/base-de-datos', self.client.get('/econometria').data)
        self.assertEqual(self.client.get('/api/base-datos/catalogo').status_code, 200)

    def test_pilot_remains_available_until_published_mode_is_enabled(self):
        with patch.dict(os.environ, CHARTBAY_DATABASE_MODE='pilot'):
            payload = self.client.get('/api/base-datos/catalogo').get_json()
        self.assertEqual(payload['source'], 'pilot')
        self.assertEqual(len(payload['series']), 100)
        self.assertEqual(sum(s['available'] for s in payload['series']), 31)

    def test_missing_pilot_catalogue_returns_actionable_503(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, CHARTBAY_DATA_DIR=directory, CHARTBAY_DATABASE_MODE='pilot'):
            response = self.client.get('/api/base-datos/catalogo')
            self.assertEqual(response.status_code, 503)
            self.assertFalse(response.get_json()['ok'])

    def test_duplicate_ids_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, CHARTBAY_DATA_DIR=directory, CHARTBAY_DATABASE_MODE='pilot'):
            (Path(directory) / 'catalogo.json').write_text(json.dumps({'schema_version': 1, 'series': [{'id': 'a'}, {'id': 'a'}]}))
            with self.assertRaises(ValueError):
                read_pilot_snapshot(ROOT)

    def test_flag_disables_page_and_api(self):
        with patch.dict(SECCIONES, base_datos=False):
            self.assertEqual(self.client.get('/base-de-datos').status_code, 404)
            self.assertEqual(self.client.get('/api/base-datos/catalogo').status_code, 404)

    def test_invalid_root_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, CHARTBAY_DATA_DIR=directory, CHARTBAY_DATABASE_MODE='pilot'):
            (Path(directory) / 'catalogo.json').write_text('null')
            with self.assertRaises(ValueError):
                read_pilot_snapshot(ROOT)


if __name__ == '__main__':
    unittest.main()
