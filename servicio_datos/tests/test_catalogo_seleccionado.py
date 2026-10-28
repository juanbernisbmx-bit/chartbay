"""Contratos públicos y recolección probados en PostgreSQL temporal, sin red."""
import json
from pathlib import Path

from servicio_datos.tests.test_instalacion_lectura_publica import InstallationTests, SQL_DIR


class SelectedCatalogueTests(InstallationTests):
    def install_selected(self):
        self.install()
        self.run_sql("CREATE ROLE servicio_datos NOLOGIN;") if self.scalar("SELECT count(*) FROM pg_roles WHERE rolname='servicio_datos';")=="0" else None
        for file in ('03_catalogo_paginado.sql','04_colecta_series_api.sql'):
            self.run_sql((SQL_DIR/file).read_text())

    def seed(self, count=1):
        self.run_sql(f"""
          SET search_path TO economia,public;
          INSERT INTO fuente(id,nombre,licencia,atribucion) VALUES('VISIBLE','Productor','CC BY 4.0','Fuente: Productor');
          INSERT INTO serie(id,fuente_id,nombre,tema,nivel,frecuencia)
            SELECT 'serie_'||n,'VISIBLE','Serie '||lpad(n::text,3,'0'),'Actividad','Nacional','Mensual' FROM generate_series(1,{count}) n;
          WITH co AS (INSERT INTO corrida(fuente_id,estado,terminada_en) VALUES('VISIBLE','con_candidato',now()) RETURNING id),
          ca AS (INSERT INTO candidato(corrida_id,estado,decidido_en,decidido_por) SELECT id,'publicado',now(),'prueba' FROM co RETURNING id),
          r AS (INSERT INTO release(release_id,candidato_id,aprobado_por,hash_contenido) SELECT 'prueba',id,'prueba',repeat('a',64) FROM ca RETURNING numero)
          INSERT INTO observacion(serie_id,periodo,valor,release_desde) SELECT s.id,'2026-01-01',100.25,r.numero FROM serie s CROSS JOIN r;
        """)

    def test_pages_only_contain_published_metadata_and_detail_loads_values(self):
        self.install_selected();self.seed(55)
        first=json.loads(self.scalar("SET ROLE anon; SELECT public.buscar_series_economicas()::text;"))
        second=json.loads(self.scalar("SET ROLE anon; SELECT public.buscar_series_economicas('','','',2)::text;"))
        self.assertEqual(first['total'],55)
        self.assertEqual(len(first['series']),50);self.assertEqual(len(second['series']),5)
        self.assertTrue(all(s['observations']==[] for s in first['series']))
        ids=[s['id'] for s in first['series']+second['series']]
        self.assertEqual(len(set(ids)),55)
        self.assertEqual(json.loads(self.scalar("SET ROLE anon; SELECT public.serie_economica_publicada('serie_1')::text;"))['observations'],[{'date':'2026-01-01','value':100.25}])
        self.run_sql("UPDATE economia.fuente SET licencia=NULL WHERE id='VISIBLE';")
        self.assertEqual(json.loads(self.scalar("SET ROLE anon; SELECT public.buscar_series_economicas()::text;"))['total'],0)
        self.assertEqual(self.scalar("SET ROLE anon; SELECT public.serie_economica_publicada('serie_1') IS NULL;"),'t')
        self.assertNotEqual(self.run_sql("SET ROLE anon; SELECT * FROM economia.observacion_candidata;",check=False).returncode,0)

    def test_collector_leases_precision_repetition_changes_and_failed_runs(self):
        self.install_selected()
        self.run_sql("""INSERT INTO economia.fuente(id,nombre) VALUES('PRUEBA','Productor');
          INSERT INTO economia.serie(id,fuente_id,nombre,frecuencia) VALUES('ar_test','PRUEBA','Prueba','Mensual');
          INSERT INTO economia.consulta_serie_api(serie_id,upstream_id) VALUES('ar_test','oficial');""")
        def take():
            return json.loads(self.scalar("SET ROLE servicio_datos; SELECT servicio_series.tomar()::text;"))['trabajos'][0]
        job=take()
        self.assertEqual(json.loads(self.scalar("SET ROLE servicio_datos; SELECT servicio_series.tomar()::text;"))['trabajos'],[])
        points='[["2026-01-01","1.000000000000000001"],["2026-03-01","0"]]'
        original=json.dumps({'upstream_id':'oficial','sha256':'a'*64,'bytes':100,'ruta':'series-api/'+'a'*64+'.json','url':'https://apis.datos.gob.ar/series/api/series/?ids=oficial'})
        def load(job,p=points):
            return json.loads(self.scalar(f"SET ROLE servicio_datos; SELECT servicio_series.cargar('ar_test','{job['token']}','{p}'::jsonb,'{original}'::jsonb)::text;"))
        first=load(job);self.assertEqual(first['estado'],'con_candidato')
        self.assertEqual(load(job)['estado'],'sin_cambios')
        self.assertEqual(self.scalar("SELECT count(*) FROM economia.candidato;"),'1')
        self.assertEqual(self.scalar("SELECT valor FROM economia.observacion_candidata ORDER BY periodo LIMIT 1;"),'1.000000000000000001')
        self.assertEqual(self.scalar("SELECT count(*) FROM economia.release;"),'0')
        with self.assertRaisesRegex(AssertionError,'futuros'):
            load(job,'[["2099-01-01","1"]]')
        self.assertEqual(self.scalar("SELECT count(*) FROM economia.candidato;"),'1')
        self.scalar(f"SET ROLE servicio_datos; SELECT servicio_series.terminar('ar_test','{job['token']}');")
        self.run_sql("UPDATE economia.consulta_serie_api SET proxima=now()-interval '1 minute';")
        job=take();changed=load(job,points.replace('1.000000000000000001','2'))
        self.assertEqual(changed['estado'],'con_candidato')
        self.assertEqual(self.scalar("SELECT count(*) FROM economia.candidato WHERE estado='descartado';"),'1')
        self.scalar(f"SET ROLE servicio_datos; SELECT servicio_series.terminar('ar_test','{job['token']}','Fallo de red');")
        self.assertEqual(self.scalar("SELECT fallos FROM economia.consulta_serie_api;"),'1')
        self.assertEqual(self.scalar("SELECT ultimo_error FROM economia.consulta_serie_api;"),'Fallo de red')
        self.assertNotEqual(self.run_sql("SET ROLE servicio_datos; SELECT * FROM economia.observacion_candidata;",check=False).returncode,0)

    def test_schedule_requires_configuration_and_keeps_both_authentication_headers(self):
        self.install_selected();self.seed()
        self.run_sql("""CREATE SCHEMA vault; CREATE TABLE vault.secrets(name text);
          CREATE SCHEMA cron; CREATE TABLE cron.test_job(name text,schedule text,command text);
          CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql AS $$
            INSERT INTO cron.test_job VALUES($1,$2,$3) RETURNING 1::bigint $$;""")
        sql=(SQL_DIR/'05_programar_series.sql').read_text()
        self.assertNotEqual(self.run_sql(sql,check=False).returncode,0)
        self.run_sql("""INSERT INTO vault.secrets VALUES('project_url'),('clave_cron'),('clave_publica_jwt');
          INSERT INTO economia.consulta_serie_api(serie_id,upstream_id) VALUES('serie_1','oficial');""")
        self.run_sql(sql)
        self.assertEqual(self.scalar('SELECT schedule FROM cron.test_job;'),'*/2 * * * *')
        command=self.scalar('SELECT command FROM cron.test_job;')
        self.assertIn('Authorization',command);self.assertIn('clave_publica_jwt',command)
        self.assertIn('x-chartbay-clave',command);self.assertNotIn('service_role',command)
