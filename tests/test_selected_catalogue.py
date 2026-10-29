import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError, URLError

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from web.app import app
import economic_catalogue as catalogue


class SelectedCatalogueWebTests(unittest.TestCase):
    def setUp(self):
        self.client=app.test_client()
        env=patch.dict(os.environ,CHARTBAY_DATABASE_MODE='selected')
        env.start();self.addCleanup(env.stop)
        catalogue._page.cache_clear();self.addCleanup(catalogue._page.cache_clear)

    def test_catalogue_checks_filters_before_network(self):
        for url in ['/api/base-datos/catalogo?page=0','/api/base-datos/catalogo?page=x','/api/base-datos/catalogo?q='+'x'*201]:
            self.assertEqual(self.client.get(url).status_code,400)

    def test_paging_returns_metadata_and_series_are_separate(self):
        payload={'schema_version':1,'paginated':True,'series':[],'total':0,'page':1}
        with patch('web.app.catalogue_page',return_value=payload) as call:
            response=self.client.get('/api/base-datos/catalogo?q=empleo&topic=Actividad&page=2')
        self.assertEqual(response.status_code,200)
        self.assertEqual(call.call_args.args[2:],('empleo','Actividad','',2,''))
        with patch('web.app.selected_series',return_value=None):
            self.assertEqual(self.client.get('/api/base-datos/serie/privada').status_code,404)

    def test_paged_reader_rejects_accidental_full_catalogue_download(self):
        with patch.object(catalogue,'rpc',return_value={'schema_version':1,'paginated':True,'series':[{'observations':[1]}]}):
            with self.assertRaises(ValueError): catalogue.catalogue_page('https://test','public')


class PublicReadRetryTests(unittest.TestCase):
    def response(self, body=b'{"total":10}'):
        response=MagicMock()
        response.__enter__.return_value.read.return_value=body
        return response

    def test_transient_upstream_errors_recover_for_read_only_rpc(self):
        for error in [HTTPError('https://test',500,'Temporary',{},None),URLError('Temporary'),TimeoutError()]:
            with patch.object(catalogue,'urlopen',side_effect=[error,self.response()]) as call, patch.object(catalogue.time,'sleep'):
                self.assertEqual(catalogue.rpc('https://test','public','buscar_series_economicas',{}),{'total':10})
                self.assertEqual(call.call_count,2)

    def test_persistent_upstream_error_stops_after_one_retry(self):
        with patch.object(catalogue,'urlopen',side_effect=HTTPError('https://test',503,'Temporary',{},None)) as call, patch.object(catalogue.time,'sleep'):
            with self.assertRaises(HTTPError):catalogue.rpc('https://test','public','buscar_series_economicas',{})
            self.assertEqual(call.call_count,2)

    def test_denied_or_invalid_data_is_not_retried(self):
        with patch.object(catalogue,'urlopen',side_effect=HTTPError('https://test',401,'Denied',{},None)) as call:
            with self.assertRaises(HTTPError):catalogue.rpc('https://test','public','buscar_series_economicas',{})
            self.assertEqual(call.call_count,1)
        with patch.object(catalogue,'urlopen',return_value=self.response(b'not JSON')) as call:
            with self.assertRaises(ValueError):catalogue.rpc('https://test','public','buscar_series_economicas',{})
            self.assertEqual(call.call_count,1)
