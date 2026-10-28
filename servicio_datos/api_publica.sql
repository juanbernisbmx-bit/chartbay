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
