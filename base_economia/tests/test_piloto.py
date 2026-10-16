"""Comprueba el piloto contra los archivos originales conservados."""
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from unittest import mock

from scripts import preparar_piloto
from scripts.recolectar_top import discover
from scripts.preparar_piloto import build, check_coverage, month_number, read_manifest
from scripts.top_provincial import extract_rows


class PilotTests(unittest.TestCase):
    def test_catalogue_provenance_and_calendar(self):
        bundle = build()
        self.assertEqual(len(bundle['series']), 100)
        loaded = [s for s in bundle['series'] if s['available']]
        self.assertEqual(len(loaded), 8)
        self.assertEqual(sum(s['count'] for s in loaded), 851)
        for series in loaded:
            for entry in series['originals']:
                original = ROOT / 'datos' / 'originales' / entry['file']
                self.assertEqual(entry['sha256'], hashlib.sha256(original.read_bytes()).hexdigest())
        for series in (s for s in loaded if s['id'].startswith('ipc_ng_')):
            self.assertEqual(series['observations'][0], {'date': '2016-12-01', 'value': 100})
            months = [month_number(p['date']) for p in series['observations']]
            self.assertTrue(all(b - a == 1 for a, b in zip(months, months[1:])))
            self.assertTrue(any('2026-03-26' in note for note in series['normalization_notes']))
        national = next(s for s in loaded if s['id'] == 'ipc_ng_nacional')
        # Todas las series deben terminar el mismo mes. El nombre sh_ipc_MM_AA.xls lleva el
        # mes de publicación: con el de 08_26 el nacional terminaba un mes antes que las regiones.
        self.assertEqual({s['end'] for s in loaded}, {'2026-08-01'})

    def test_cordoba_top_is_monthly_and_missing_zeros_are_not_data(self):
        series = next(s for s in build()['series'] if s['id'] == 'top_mensual_cordoba')
        self.assertEqual(series['unit'], 'Millones de ARS corrientes')
        self.assertEqual(series['count'], 32)
        self.assertEqual(series['observations'][0], {'date': '2024-01-01', 'value': 129261.207832})
        self.assertEqual(series['observations'][-1], {'date': '2026-08-01', 'value': 356934.642474})
        self.assertEqual(len(series['originals']), 3)
        self.assertTrue(all(item['value'] > 0 for item in series['observations']))
        months = [month_number(item['date']) for item in series['observations']]
        self.assertTrue(all(b - a == 1 for a, b in zip(months, months[1:])))
        self.assertIsNone(series['original']['published_at'])
        self.assertIn('http_last_modified_at', series['original'])

    def test_top_rejects_interior_missing_month_and_wrong_total(self):
        rows = [(None,) * 15 for _ in range(7)]
        rows[2] = (None, 2026) + (None,) * 13
        rows[3] = (None, 'en millones de pesos') + (None,) * 13
        rows[5] = (None, 'Jurisdiccion') + (
            'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
            'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
        ) + (None,)
        rows[6] = (None, 'Córdoba', 1, 0, 3) + (0,) * 9 + (4,)
        with self.assertRaisesRegex(ValueError, 'hueco interior'):
            extract_rows(rows, 2026)
        rows[6] = (None, 'Córdoba', 1, 2) + (0,) * 10 + (999,)
        with self.assertRaisesRegex(ValueError, 'total no coincide'):
            extract_rows(rows, 2026)

    def test_top_collector_accepts_only_official_consecutive_monthly_files(self):
        html = ''.join(
            f'<a href="blank:#/sites/default/files/top_mensual_{year}_{year % 7}.xlsx">TOP</a>'
            for year in (2024, 2025, 2026)
        )
        html += '<a href="https://otro.example/top_mensual_2027_1.xlsx">Ignorar</a>'
        self.assertEqual(list(discover(html)), [2024, 2025, 2026])
        with self.assertRaisesRegex(ValueError, 'consecutivos'):
            discover(html.replace('top_mensual_2025_2.xlsx', 'trimestral_2025_2.xlsx'))

    def test_coverage_check_rejects_series_ending_in_different_months(self):
        obs = lambda end: {"observations": [{"date": "2026-07-01", "value": 1.0}, {"date": end, "value": 2.0}]}
        check_coverage({"a": obs("2026-08-01"), "b": obs("2026-08-01")})
        with self.assertRaises(ValueError) as error:
            check_coverage({"ipc_ng_nacional": obs("2026-07-01"), "ipc_ng_gba": obs("2026-08-01")})
        message = str(error.exception)
        self.assertIn("ipc_ng_nacional: 2026-07", message)
        self.assertIn("ipc_ng_gba: 2026-08", message)

    def test_build_refuses_the_stale_national_file(self):
        # sh_ipc_08_26.xls llega hasta julio y las aperturas vigentes hasta agosto:
        # es exactamente el desfase que tuvo la primera versión del piloto.
        inputs = list(preparar_piloto.INPUTS)
        inputs[0] = ("sh_ipc_08_26.xls",) + tuple(inputs[0][1:])
        with mock.patch.object(preparar_piloto, "INPUTS", tuple(inputs)):
            with self.assertRaisesRegex(ValueError, "no terminan el mismo mes"):
                build()

    def test_inputs_keep_http_date_distinct_from_publication_date(self):
        manifest = read_manifest()
        for source in (item for item in build()['inputs'] if item['file'].startswith('sh_ipc_')):
            self.assertIsNone(source['published_at'])
            self.assertEqual(source['http_last_modified_at'], manifest[source['sha256']])
            self.assertLess(datetime.fromisoformat(source['http_last_modified_at']), datetime.fromisoformat(source['retrieved_at']))
        national = next(s for s in build()['inputs'] if s['file'] == 'sh_ipc_09_26.xls')
        self.assertEqual(national['http_last_modified_at'], '2026-09-10T18:52:05+00:00')

    def test_manifest_is_optional_but_never_malformed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'manifiesto.json'
            self.assertEqual(read_manifest(path), {})
            entry = lambda when: {'version': 1, 'archivos': {'a' * 64: {'http_last_modified_at': when}}}
            path.write_text(json.dumps(entry('2026-09-10T15:52:05-03:00')), encoding='utf-8')
            self.assertEqual(read_manifest(path), {'a' * 64: '2026-09-10T18:52:05+00:00'})
            for bad in (entry('2026-09-10T18:52:05'), entry('ayer'), {'version': 2, 'archivos': {}}, {'version': 1}):
                path.write_text(json.dumps(bad), encoding='utf-8')
                with self.assertRaises(ValueError):
                    read_manifest(path)

    def test_same_inputs_produce_same_snapshot(self):
        self.assertEqual(build(), build())

    def test_git_checkout_mtime_does_not_change_snapshot(self):
        original_stat = Path.stat
        def changed_stat(path, *args, **kwargs):
            result = original_stat(path, *args, **kwargs)
            if path.name in ('sh_ipc_09_26.xls', 'sh_ipc_aperturas.xls'):
                return mock.Mock(st_mtime=1800000000)
            return result
        expected = build()
        with mock.patch.object(Path, 'stat', changed_stat):
            self.assertEqual(build(), expected)


if __name__ == '__main__':
    unittest.main()
