-- ChartBay: instalar la lectura publica en el Supabase existente.
-- Ejecutar TODO este archivo en SQL Editor, con el rol postgres.
-- Requiere el esquema economia existente (tablas, vistas de lectura y migracion 0013).
-- Instala 0017 si falta; 0015 y 0016 NO son dependencias de esta lectura.
-- No publica candidatos, no completa licencias ni programa tareas.
-- Si falla antes del COMMIT se revierte toda la instalacion.

BEGIN;
SET LOCAL search_path TO economia, public, pg_temp;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(727274);

DO $precondiciones$
DECLARE
  nombre text;
BEGIN
  IF to_regnamespace('economia') IS NULL THEN
    RAISE EXCEPTION 'Falta el esquema economia. Este script es para el proyecto existente de ChartBay.';
  END IF;
  FOREACH nombre IN ARRAY ARRAY[
    'schema_migrations', 'fuente', 'serie', 'corrida', 'candidato', 'release',
    'observacion', 'publicado_release', 'publicado_observaciones'
  ] LOOP
    IF to_regclass('economia.' || nombre) IS NULL THEN
      RAISE EXCEPTION 'Falta economia.%. Completar las migraciones anteriores del servicio antes de continuar.', nombre;
    END IF;
  END LOOP;
  IF to_regprocedure('economia.fijar_search_path()') IS NULL THEN
    RAISE EXCEPTION 'Falta la migracion 0013 (economia.fijar_search_path).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Faltan los roles anon/authenticated. Ejecutar en el proyecto Supabase de ChartBay.';
  END IF;
END
$precondiciones$;

-- Migracion 0017 original, sin modificar su contenido ni su checksum.
DO $aplicar_0017$
DECLARE
  checksum_registrado text;
BEGIN
  SELECT checksum INTO checksum_registrado
  FROM economia.schema_migrations WHERE version = '0017';
  IF FOUND THEN
    IF checksum_registrado IS DISTINCT FROM 'd6072023655d38b02d717e22d444e179c9996f7a951a8ec04fa243aa423805cb' THEN
      RAISE EXCEPTION 'La migracion 0017 tiene otro checksum. Revisar el archivo original; no se sobrescribe el registro.';
    END IF;
    RAISE NOTICE '0017 ya aplicada: se conserva.';
  ELSE
    EXECUTE $sql_0017$
-- La copia pública de lo aprobado (exportacion.py): de dónde sale cada release y con qué licencia se puede redistribuir.
--
-- Solo se exporta lo publicado. Cada release se reconstruye tal cual quedó al publicarse (las observaciones son de solo
-- agregar, con su release de alta y de baja), así que la copia de un release viejo es exactamente lo que se aprobó entonces.

-- Con qué licencia y atribución se puede redistribuir lo que viene de cada fuente. Lo completa una persona después de revisar
-- los términos de la fuente: sin esto, la fuente no se exporta.
ALTER TABLE fuente
  ADD COLUMN licencia text,      -- p. ej. 'CC BY-SA 4.0'
  ADD COLUMN licencia_url text,  -- el texto de la licencia
  ADD COLUMN atribucion text;    -- cómo hay que citarla al redistribuir

-- Los releases publicados, del más viejo al más nuevo.
CREATE FUNCTION releases_publicados() RETURNS TABLE (numero integer, release_id text, fuente_id text, publicado_en timestamptz,
                                                      hash_contenido text, procedencia jsonb)
LANGUAGE sql STABLE AS $$
  SELECT r.numero, r.release_id, co.fuente_id, r.publicado_en, r.hash_contenido, r.procedencia
  FROM release r JOIN candidato c ON c.id = r.candidato_id JOIN corrida co ON co.id = c.corrida_id
  ORDER BY r.numero
$$;

-- Lo que quedó vigente al publicar ese release, para su fuente: la foto completa que se aprobó.
CREATE FUNCTION observaciones_de_release(p_numero integer) RETURNS TABLE (serie_id text, periodo date, valor numeric)
LANGUAGE sql STABLE AS $$
  SELECT o.serie_id, o.periodo, o.valor
  FROM observacion o JOIN serie s ON s.id = o.serie_id
  WHERE s.fuente_id = (SELECT co.fuente_id FROM release r JOIN candidato c ON c.id = r.candidato_id JOIN corrida co ON co.id = c.corrida_id
                       WHERE r.numero = p_numero)
    AND o.release_desde <= p_numero AND (o.release_hasta IS NULL OR o.release_hasta > p_numero)
  ORDER BY o.serie_id COLLATE "C", o.periodo
$$;

CALL fijar_search_path();
$sql_0017$;
    INSERT INTO economia.schema_migrations (version, nombre, checksum)
    VALUES ('0017', '0017_exportacion.sql', 'd6072023655d38b02d717e22d444e179c9996f7a951a8ec04fa243aa423805cb');
    RAISE NOTICE '0017 aplicada y registrada.';
  END IF;
END
$aplicar_0017$;

-- API de solo lectura para los releases vigentes con licencia y atribucion.
-- Apply after migration 0017 in the Supabase SQL editor or with psql -f servicio_datos/api_publica.sql.
-- Read-only public contract for ChartBay. Only approved current releases from licensed sources leave economia.
-- Supabase exposes public through PostgREST; no table grants or service credential are needed by ChartBay.
CREATE OR REPLACE FUNCTION public.catalogo_economico_publicado() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = economia, pg_temp AS $$
  SELECT jsonb_build_object('schema_version', 1, 'sources', coalesce(jsonb_agg(
    jsonb_build_object(
      'release_id', r.release_id, 'source_id', f.id, 'source', f.nombre, 'source_url', f.url_base,
      'license', f.licencia, 'license_url', f.licencia_url, 'attribution', f.atribucion,
      'inputs', coalesce(r.procedencia->'archivos', '[]'::jsonb),
      'series', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'id', s.id, 'name', s.nombre, 'topic', s.tema, 'level', s.nivel,
          'territory', s.territorio, 'classification', s.clasificacion,
          'frequency', s.frecuencia, 'unit', s.unidad, 'basis', s.base,
          'input_key', r.procedencia->'series'->s.id->>'archivo',
          'sheet', r.procedencia->'series'->s.id->>'hoja',
          'source_row', r.procedencia->'series'->s.id->'fila_origen',
          'normalization_notes', coalesce(r.procedencia->'series'->s.id->'notas', '[]'::jsonb),
          'start', obs.inicio, 'end', obs.fin, 'count', obs.cantidad,
          'observations', obs.puntos
        ) ORDER BY s.id)
        FROM economia.serie s
        CROSS JOIN LATERAL (
          SELECT count(*) AS cantidad, min(o.periodo) AS inicio, max(o.periodo) AS fin,
                 jsonb_agg(jsonb_build_object('date', o.periodo, 'value', o.valor) ORDER BY o.periodo) AS puntos
          FROM economia.publicado_observaciones o
          WHERE o.serie_id = s.id AND o.fuente_id = f.id
        ) obs
        WHERE s.fuente_id = f.id AND obs.cantidad > 0
      ), '[]'::jsonb)
    ) ORDER BY f.id), '[]'::jsonb))
  FROM economia.publicado_release r
  JOIN economia.fuente f ON f.id = r.fuente_id
  WHERE nullif(btrim(f.licencia), '') IS NOT NULL
    AND nullif(btrim(f.atribucion), '') IS NOT NULL
$$;

REVOKE ALL ON FUNCTION public.catalogo_economico_publicado() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    GRANT USAGE ON SCHEMA public TO anon;
    GRANT EXECUTE ON FUNCTION public.catalogo_economico_publicado() TO anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT USAGE ON SCHEMA public TO authenticated;
    GRANT EXECUTE ON FUNCTION public.catalogo_economico_publicado() TO authenticated;
  END IF;
END $$;


-- La comprobacion tambien debe funcionar con los permisos publicos.
-- SET ROLE es local a esta transaccion y se restaura antes de confirmar.
SET LOCAL ROLE anon;
SELECT public.catalogo_economico_publicado() AS comprobacion_anon;
RESET ROLE;

-- Refrescar la API de Supabase para que reconozca la nueva funcion.
NOTIFY pgrst, 'reload schema';
COMMIT;

-- Resultado final: sources=[] es correcto si todavia no hay releases elegibles.
SELECT public.catalogo_economico_publicado() AS catalogo_publico;
