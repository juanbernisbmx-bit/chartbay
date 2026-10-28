-- Se instala después de 04, registrar las consultas y desplegar colectar-series.
-- Usa los secretos existentes del cron IPC y el JWT público anon del proyecto.
-- Mantiene la verificación JWT de la función. No contiene ni imprime sus valores.
BEGIN;
DO $$ BEGIN
  IF (SELECT count(*) FROM vault.secrets WHERE name IN ('project_url','clave_cron','clave_publica_jwt'))<>3 THEN
    RAISE EXCEPTION 'Faltan la configuración de proyecto, cron o JWT público';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM economia.consulta_serie_api) THEN
    RAISE EXCEPTION 'No hay series registradas para consultar';
  END IF;
END $$;
SELECT cron.schedule('colectar-series-seleccionadas','*/2 * * * *',$job$
  SELECT net.http_post(
    url:=(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='project_url')||'/functions/v1/colectar-series',
    headers:=jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer '||(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='clave_publica_jwt'),
      'x-chartbay-clave',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='clave_cron')),
    body:='{}'::jsonb,timeout_milliseconds:=140000)
$job$);
COMMIT;
