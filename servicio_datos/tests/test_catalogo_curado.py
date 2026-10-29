import json
from servicio_datos.tests import test_catalogo_seleccionado as previous


class CuratedTests(previous.SelectedCatalogueTests):
    def install_curated(self):
        self.install_selected()
        self.run_sql("CREATE SCHEMA storage; CREATE TABLE storage.objects(metadata jsonb);")
        for name in ['06_catalogo_curado.sql','07_colecta_curada.sql']:
            self.run_sql((previous.SQL_DIR/name).read_text())

    def register(self):
        self.run_sql("""UPDATE economia.serie SET unidad='';
          INSERT INTO economia.consulta_serie_api(serie_id,upstream_id) VALUES('serie_1','oficial');
          INSERT INTO economia.catalogo_curado VALUES('serie_1',true,'datos_csv','oficial','valor','https://infra.datos.gob.ar/catalog/sspm/prueba.csv','Mensual','','Prueba','2020-01-01',now()::date,'prueba');
          UPDATE economia.catalogo_curado_config SET activo=true;
        """)

    def test_automatic_publication_precision_idempotence_and_closed_scope(self):
        self.install_curated();self.seed();self.register()
        job=json.loads(self.scalar('SET ROLE servicio_datos; SELECT servicio_series.tomar_curado()::text;'))['trabajos'][0]
        date=self.scalar("SELECT date_trunc('month',now())::date;")
        points=json.dumps([['2026-01-01','100.25'],[date,'1.000000000000000001']])
        original=json.dumps(dict(upstream_id='oficial',url=job['url'],sha256='a'*64,bytes=100,ruta='curado/'+'a'*64+'.json'))
        def load(p=points):
            return json.loads(self.scalar(f"SET ROLE servicio_datos; SELECT servicio_series.cargar_curado('serie_1','{job['token']}','{p}'::jsonb,'{original}'::jsonb)::text;"))
        self.assertEqual(load()['estado'],'publicado')
        self.assertEqual(self.scalar("SELECT valor FROM economia.publicado_observaciones WHERE periodo=date_trunc('month',now())::date;"),'1.000000000000000001')
        count=self.scalar('SELECT count(*) FROM economia.release;')
        self.assertEqual(load()['estado'],'sin_cambios')
        self.assertEqual(self.scalar('SELECT count(*) FROM economia.release;'),count)
        with self.assertRaisesRegex(AssertionError,'omite períodos'):
            load(json.dumps([[date,'2']]))
        self.assertEqual(self.scalar('SELECT count(*) FROM economia.release;'),count)
        with self.assertRaisesRegex(AssertionError,'incompatibles'):
            load('[["2099-01-01","1"]]')
        self.assertNotEqual(self.run_sql('SET ROLE servicio_datos; SELECT * FROM economia.catalogo_curado;',check=False).returncode,0)
        self.assertNotEqual(self.run_sql("SET ROLE anon; SELECT servicio_series.tomar_curado();",check=False).returncode,0)
        self.run_sql("UPDATE economia.catalogo_curado SET incluida=false;")
        self.assertEqual(self.scalar("SET ROLE anon; SELECT public.serie_economica_publicada('serie_1') IS NULL;"),'t')
        self.assertEqual(self.scalar('SELECT count(*) FROM economia.release;'),count)

    def test_reader_keeps_daily_and_annual_dates_and_frequency_filter(self):
        self.install_curated()
        for sid,frequency,period in [('diaria','Diaria','now()::date'),('anual','Anual',"(date_trunc('year',now())-interval '1 year')::date")]:
            fid=sid.upper()
            self.run_sql(f"""INSERT INTO economia.fuente(id,nombre,licencia,atribucion) VALUES('{fid}','Productor','CC BY 4.0','Fuente: Productor');
              INSERT INTO economia.serie(id,fuente_id,nombre,frecuencia,unidad) VALUES('{sid}','{fid}','Serie {sid}','{frequency}','u');
              WITH co AS (INSERT INTO economia.corrida(fuente_id,estado,terminada_en) VALUES('{fid}','con_candidato',now()) RETURNING id),
              ca AS (INSERT INTO economia.candidato(corrida_id,estado,decidido_en,decidido_por) SELECT id,'publicado',now(),'prueba' FROM co RETURNING id),
              r AS (INSERT INTO economia.release(release_id,candidato_id,aprobado_por,hash_contenido) SELECT '{sid}',id,'prueba',repeat('a',64) FROM ca RETURNING numero)
              INSERT INTO economia.observacion(serie_id,periodo,valor,release_desde) SELECT '{sid}',{period},1,r.numero FROM r;
              INSERT INTO economia.catalogo_curado VALUES('{sid}',true,'datos_csv','{sid}','valor','https://infra.datos.gob.ar/catalog/sspm/prueba.csv','{frequency}','u','Prueba','2020-01-01',now()::date,'prueba');
            """)
        self.run_sql('UPDATE economia.catalogo_curado_config SET activo=true;')
        page=json.loads(self.scalar("SET ROLE anon; SELECT public.buscar_series_economicas('','','',1,'Diaria')::text;"))
        self.assertEqual(page['total'],1);self.assertEqual(page['series'][0]['frequency'],'Diaria')
        self.assertEqual(page['series'][0]['observations'],[])
        self.assertEqual(json.loads(self.scalar("SET ROLE anon; SELECT public.buscar_series_economicas('','','',1,'Anual')::text;"))['total'],1)
        detail=json.loads(self.scalar("SET ROLE anon; SELECT public.serie_economica_publicada('anual')::text;"))
        self.assertEqual(detail['frequency'],'Anual');self.assertEqual(len(detail['observations']),1)
